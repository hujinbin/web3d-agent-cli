import type { ToolContext } from '../types.js';
import { checkAbort, inputKeys, MAX_OUTPUT_CHARS, readText, walkFiles, workspacePath } from './workspace.js';

const MAX_DEPTH = 5;
const MAX_FILES = 1500;
const MAX_FILES_PER_DOMAIN = 60;
const MAX_DIAGNOSTICS = 30;
const MAX_SKIPPED_DETAILS = 15;

export type ProjectDiagnosticCode = 'threejs.cleanup-review' | 'python.async-blocking-review' | 'python.cors-wildcard-review';
export type ProjectSkipReason = 'sample_limit' | 'too_large' | 'binary' | 'invalid_encoding' | 'read_error';

export interface ProjectDiagnostic {
  code: ProjectDiagnosticCode;
  level: 'review';
  file: string;
  line: number;
  evidence: string;
  message: string;
}

export interface ProjectSkippedFile {
  file: string;
  reason: ProjectSkipReason;
  message: string;
}

export interface ProjectReport {
  schemaVersion: 1;
  scope: string;
  filesScanned: number;
  truncated: boolean;
  summary: {
    listedFiles: number;
    candidateFiles: number;
    scannedFiles: number;
    skippedFiles: number;
    notApplicableFiles: number;
    skippedByReason: Record<ProjectSkipReason, number>;
    diagnosticsTotal: number;
    diagnosticsReturned: number;
  };
  limits: { maxDepth: number; maxListedFiles: number; maxFilesPerDomain: number; maxDiagnostics: number };
  coverage: { listingTruncated: boolean; samplingTruncated: boolean; diagnosticsTruncated: boolean; skippedDetailsTruncated: boolean; contractFilesTruncated: boolean };
  frontend: { files: number; sampled: number; threeDetected: boolean };
  backend: { pythonFiles: number; sampled: number };
  contractFiles: string[];
  diagnostics: ProjectDiagnostic[];
  skipped: ProjectSkippedFile[];
  suggestedChecks: string[];
}

function skipReason(error: unknown): ProjectSkipReason {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('1 MiB')) return 'too_large';
  if (message.includes('二进制')) return 'binary';
  if (message.includes('UTF-8')) return 'invalid_encoding';
  return 'read_error';
}

function updateTruncation(report: ProjectReport): void {
  report.summary.diagnosticsReturned = report.diagnostics.length;
  report.coverage.diagnosticsTruncated = report.summary.diagnosticsTotal > report.diagnostics.length;
  report.coverage.skippedDetailsTruncated = report.summary.skippedFiles > report.skipped.length;
  report.truncated = Object.values(report.coverage).some(Boolean);
}

export async function inspectProject(context: ToolContext, input: Record<string, unknown> = {}): Promise<ProjectReport> {
  inputKeys(input, []);
  const listing = await walkFiles(context, await workspacePath(context, '.'), MAX_DEPTH, MAX_FILES);
  const frontendFiles = listing.files.filter(file => /\.(tsx?|jsx?|vue)$/i.test(file));
  const pythonFiles = listing.files.filter(file => /\.py$/i.test(file));
  const contractFiles = listing.files.filter(file => /(?:openapi|schema|contract|pydantic)/i.test(file));
  const report: ProjectReport = {
    schemaVersion: 1,
    scope: '有界启发式源码检查，结果为待核查线索；覆盖范围由 limits 和 coverage 说明。',
    filesScanned: 0,
    truncated: listing.truncated,
    summary: {
      listedFiles: listing.files.length,
      candidateFiles: frontendFiles.length + pythonFiles.length,
      scannedFiles: 0,
      skippedFiles: 0,
      notApplicableFiles: listing.files.length - frontendFiles.length - pythonFiles.length,
      skippedByReason: { sample_limit: 0, too_large: 0, binary: 0, invalid_encoding: 0, read_error: 0 },
      diagnosticsTotal: 0,
      diagnosticsReturned: 0,
    },
    limits: { maxDepth: MAX_DEPTH, maxListedFiles: MAX_FILES, maxFilesPerDomain: MAX_FILES_PER_DOMAIN, maxDiagnostics: MAX_DIAGNOSTICS },
    coverage: { listingTruncated: listing.truncated, samplingTruncated: false, diagnosticsTruncated: false, skippedDetailsTruncated: false, contractFilesTruncated: contractFiles.length > 20 },
    frontend: { files: frontendFiles.length, sampled: 0, threeDetected: false },
    backend: { pythonFiles: pythonFiles.length, sampled: 0 },
    contractFiles: contractFiles.slice(0, 20),
    diagnostics: [],
    skipped: [],
    suggestedChecks: [
      ...(frontendFiles.length ? ['按项目既有脚本执行类型检查与构建，并在浏览器核查相机、resize、动画与资源清理。'] : []),
      ...(pythonFiles.length ? ['在项目指定的 Python 环境执行既有测试，核对 API 输入输出与异步调用路径。'] : []),
    ],
  };

  const skip = (file: string, reason: ProjectSkipReason, message: string): void => {
    report.summary.skippedFiles++;
    report.summary.skippedByReason[reason]++;
    if (report.skipped.length < MAX_SKIPPED_DETAILS) report.skipped.push({ file, reason, message });
  };
  const diagnose = (diagnostic: ProjectDiagnostic): void => {
    report.summary.diagnosticsTotal++;
    if (report.diagnostics.length < MAX_DIAGNOSTICS) report.diagnostics.push(diagnostic);
  };

  for (const [domain, files] of [['frontend', frontendFiles], ['backend', pythonFiles]] as const) {
    for (const [index, file] of files.entries()) {
      checkAbort(context);
      if (index >= MAX_FILES_PER_DOMAIN) {
        report.coverage.samplingTruncated = true;
        skip(file, 'sample_limit', '超过该领域的本次文件采样上限');
        continue;
      }
      let content: string;
      try {
        content = await readText(await workspacePath(context, file));
      } catch (error) {
        checkAbort(context);
        skip(file, skipReason(error), error instanceof Error ? error.message : String(error));
        continue;
      }
      checkAbort(context);
      report.filesScanned++;
      report.summary.scannedFiles++;
      report[domain].sampled++;
      const lines = content.split('\n');
      if (domain === 'frontend') {
        const three = /from\s*['"](?:three(?:\/[^'"]*)?|@react-three\/fiber)['"]|\bTHREE\./.test(content);
        report.frontend.threeDetected ||= three;
        const animationLine = lines.findIndex(line => /requestAnimationFrame|setAnimationLoop|useFrame/.test(line));
        if (three && animationLine >= 0 && !/\.dispose\s*\(/.test(content)) {
          diagnose({
            code: 'threejs.cleanup-review', level: 'review', file, line: animationLine + 1,
            evidence: lines[animationLine]!.trim().slice(0, 240),
            message: '该文件出现 Three.js 动画调用，未见显式 dispose。请结合框架及共享资源所有权核查清理路径。',
          });
        }
      } else {
        const blockingLine = lines.findIndex(line => /\btime\.sleep\s*\(|\brequests\.(get|post|put|delete)\s*\(/.test(line));
        if (/\basync\s+def\b/.test(content) && blockingLine >= 0) {
          diagnose({
            code: 'python.async-blocking-review', level: 'review', file, line: blockingLine + 1,
            evidence: lines[blockingLine]!.trim().slice(0, 240),
            message: '该文件同时出现 async def 与同步阻塞调用，请核查这条调用是否进入异步请求路径。',
          });
        }
        const cors = /allow_origins\s*=\s*\[\s*['"]\*['"]/.exec(content);
        if (/CORSMiddleware/.test(content) && cors) {
          const line = content.slice(0, cors.index).split('\n').length;
          diagnose({
            code: 'python.cors-wildcard-review', level: 'review', file, line,
            evidence: content.slice(cors.index, cors.index + cors[0].length).slice(0, 240),
            message: '发现通配 CORS 来源配置，请核查部署来源与凭据策略。',
          });
        }
      }
    }
  }
  updateTruncation(report);
  // 控制最终 JSON 大小，保留统计结果并明确标记被省略的明细。
  while (JSON.stringify(report).length > MAX_OUTPUT_CHARS) {
    if (report.skipped.length) report.skipped.pop();
    else if (report.contractFiles.length) { report.contractFiles.pop(); report.coverage.contractFilesTruncated = true; }
    else if (report.diagnostics.length) report.diagnostics.pop();
    else throw new Error('项目诊断报告超过输出预算');
    updateTruncation(report);
  }
  return report;
}
