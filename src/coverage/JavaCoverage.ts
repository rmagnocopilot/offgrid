import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';

const execFileAsync = promisify(execFile);

export interface CoverageCounter {
  missed: number;
  covered: number;
}

export interface JavaCoverageMethod {
  name: string;
  descriptor?: string;
  line?: number;
  instruction: CoverageCounter;
  branch: CoverageCounter;
  lineCounter: CoverageCounter;
  complexity: CoverageCounter;
}

export interface JavaCoverageClass {
  name: string;
  packageName: string;
  sourceFile?: string;
  methods: JavaCoverageMethod[];
}

export interface JavaCoverageSummary {
  className?: string;
  methodsTotal: number;
  methodsFullyCovered: number;
  methodsPartiallyCovered: number;
  methodsUncovered: number;
  uncoveredMethods: Array<{ name: string; descriptor?: string; line?: number; missedInstructions: number; missedBranches: number }>;
  partialMethods: Array<{ name: string; descriptor?: string; line?: number; missedInstructions: number; missedBranches: number }>;
}

export interface JavaCoveragePlan {
  moduleRoot: string;
  buildSystem: 'maven' | 'gradle';
  configured: boolean;
  command: string;
  cwd: string;
  reportCandidates: string[];
  reason?: string;
}

export interface JavaCoverageRunResult {
  plan: JavaCoveragePlan;
  reportPath: string;
  summary: JavaCoverageSummary;
  stdout: string;
  stderr: string;
}

export async function buildJavaCoveragePlan(workspaceRoot: string, sourceFile: string): Promise<JavaCoveragePlan> {
  const relative = normalizeRelativePath(sourceFile);
  if (!/\.java$/i.test(relative)) throw new Error('A cobertura JaCoCo exige um arquivo Java como alvo.');
  const marker = relative.toLowerCase().indexOf('/src/main/java/');
  const moduleRoot = marker >= 0 ? relative.slice(0, marker) : '';
  const moduleAbsolute = resolveInsideRoot(workspaceRoot, moduleRoot || '.');
  const rootAbsolute = path.resolve(workspaceRoot);

  const pom = resolveInsideRoot(workspaceRoot, moduleRoot ? path.posix.join(moduleRoot, 'pom.xml') : 'pom.xml');
  if (fileExists(pom)) {
    const pomFiles = [pom, path.join(rootAbsolute, 'pom.xml')].filter((value, index, values) => values.indexOf(value) === index && fileExists(value));
    const texts = await Promise.all(pomFiles.map(value => fsp.readFile(value, 'utf8')));
    const configured = texts.some(text => /jacoco-maven-plugin|org\.jacoco/i.test(text));
    const wrapper = firstExisting([
      path.join(moduleAbsolute, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'),
      path.join(rootAbsolute, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw')
    ]);
    const executable = wrapper ?? 'mvn';
    const command = `${executableCommand(executable)} -q test jacoco:report`;
    return {
      moduleRoot,
      buildSystem: 'maven',
      configured,
      command,
      cwd: moduleAbsolute,
      reportCandidates: [
        path.join(moduleAbsolute, 'target', 'site', 'jacoco', 'jacoco.xml'),
        path.join(moduleAbsolute, 'target', 'site', 'jacoco-aggregate', 'jacoco.xml')
      ],
      reason: configured ? undefined : 'O pom.xml não possui configuração JaCoCo comprovada.'
    };
  }

  const gradle = ['build.gradle', 'build.gradle.kts']
    .map(name => resolveInsideRoot(workspaceRoot, moduleRoot ? path.posix.join(moduleRoot, name) : name))
    .find(fileExists);
  if (gradle) {
    const text = await fsp.readFile(gradle, 'utf8');
    const configured = /\bjacoco\b/i.test(text);
    const wrapper = firstExisting([
      path.join(moduleAbsolute, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'),
      path.join(rootAbsolute, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
    ]);
    const executable = wrapper ?? 'gradle';
    const command = `${executableCommand(executable)} test jacocoTestReport`;
    return {
      moduleRoot,
      buildSystem: 'gradle',
      configured,
      command,
      cwd: moduleAbsolute,
      reportCandidates: [
        path.join(moduleAbsolute, 'build', 'reports', 'jacoco', 'test', 'jacocoTestReport.xml'),
        path.join(moduleAbsolute, 'build', 'reports', 'jacoco', 'test', 'jacoco.xml')
      ],
      reason: configured ? undefined : 'O build.gradle não possui plugin/configuração JaCoCo comprovada.'
    };
  }

  throw new Error('Não foi possível localizar pom.xml ou build.gradle no módulo Java alvo.');
}

export async function runJavaCoveragePlan(plan: JavaCoveragePlan, targetClass?: string): Promise<JavaCoverageRunResult> {
  if (!plan.configured) throw new Error(plan.reason ?? 'JaCoCo não está configurado neste módulo.');
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', plan.command]
    : ['-lc', plan.command];
  const { stdout, stderr } = await execFileAsync(shell, args, {
    cwd: plan.cwd,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
  const reportPath = plan.reportCandidates.find(fileExists);
  if (!reportPath) {
    throw new Error('O comando JaCoCo terminou, mas nenhum jacoco.xml foi encontrado nos caminhos esperados.');
  }
  const xml = await fsp.readFile(reportPath, 'utf8');
  const summary = summarizeJacocoXml(xml, targetClass);
  return {
    plan,
    reportPath,
    summary,
    stdout: tail(stdout, 6_000),
    stderr: tail(stderr, 3_000)
  };
}

export function summarizeJacocoXml(xml: string, targetClass?: string): JavaCoverageSummary {
  const classes = parseJacocoXml(xml);
  const target = targetClass ? normalizeClassName(targetClass) : undefined;
  const selected = target
    ? classes.filter(item => normalizeClassName(item.name) === target || normalizeClassName(item.name).endsWith(`/${target}`))
    : classes;
  if (target && !selected.length) {
    throw new Error(`A classe ${targetClass} não apareceu no relatório JaCoCo.`);
  }
  const methods = selected.flatMap(item => item.methods).filter(method => !/^<.*>$/.test(method.name));
  const uncoveredMethods: JavaCoverageSummary['uncoveredMethods'] = [];
  const partialMethods: JavaCoverageSummary['partialMethods'] = [];
  let fully = 0;
  for (const method of methods) {
    const missedInstructions = method.instruction.missed;
    const coveredInstructions = method.instruction.covered;
    const missedBranches = method.branch.missed;
    const coveredBranches = method.branch.covered;
    const hasCoverage = coveredInstructions > 0 || coveredBranches > 0;
    const hasMiss = missedInstructions > 0 || missedBranches > 0;
    const entry = { name: method.name, descriptor: method.descriptor, line: method.line, missedInstructions, missedBranches };
    if (!hasCoverage && hasMiss) uncoveredMethods.push(entry);
    else if (hasMiss) partialMethods.push(entry);
    else fully += 1;
  }
  return {
    className: targetClass,
    methodsTotal: methods.length,
    methodsFullyCovered: fully,
    methodsPartiallyCovered: partialMethods.length,
    methodsUncovered: uncoveredMethods.length,
    uncoveredMethods: uncoveredMethods.slice(0, 80),
    partialMethods: partialMethods.slice(0, 80)
  };
}

export function parseJacocoXml(xml: string): JavaCoverageClass[] {
  const result: JavaCoverageClass[] = [];
  const packagePattern = /<package\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/package>/g;
  for (const packageMatch of xml.matchAll(packagePattern)) {
    const packageName = decodeXml(packageMatch[1] ?? '').replace(/\//g, '.');
    const packageBody = packageMatch[2] ?? '';
    const classPattern = /<class\s+([^>]*?)>([\s\S]*?)<\/class>/g;
    for (const classMatch of packageBody.matchAll(classPattern)) {
      const attributes = parseAttributes(classMatch[1] ?? '');
      const className = attributes.name;
      if (!className) continue;
      const classBody = classMatch[2] ?? '';
      const methods: JavaCoverageMethod[] = [];
      const methodPattern = /<method\s+([^>]*?)>([\s\S]*?)<\/method>/g;
      for (const methodMatch of classBody.matchAll(methodPattern)) {
        const methodAttributes = parseAttributes(methodMatch[1] ?? '');
        if (!methodAttributes.name) continue;
        const body = methodMatch[2] ?? '';
        methods.push({
          name: methodAttributes.name,
          descriptor: methodAttributes.desc,
          line: numberValue(methodAttributes.line),
          instruction: counter(body, 'INSTRUCTION'),
          branch: counter(body, 'BRANCH'),
          lineCounter: counter(body, 'LINE'),
          complexity: counter(body, 'COMPLEXITY')
        });
      }
      result.push({
        name: decodeXml(className),
        packageName,
        sourceFile: attributes.sourcefilename ? decodeXml(attributes.sourcefilename) : undefined,
        methods
      });
    }
  }
  return result;
}

function counter(body: string, type: string): CoverageCounter {
  const pattern = new RegExp(`<counter\\s+[^>]*type="${type}"[^>]*\\/>`, 'i');
  const tag = body.match(pattern)?.[0] ?? '';
  const attrs = parseAttributes(tag);
  return { missed: numberValue(attrs.missed) ?? 0, covered: numberValue(attrs.covered) ?? 0 };
}

function parseAttributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    if (match[1]) result[match[1].toLowerCase()] = decodeXml(match[2] ?? '');
  }
  return result;
}

function normalizeClassName(value: string): string {
  return value.replace(/\\/g, '/').replace(/\.java$/i, '').replace(/\./g, '/').replace(/^\/+/, '');
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstExisting(values: string[]): string | undefined {
  return values.find(fileExists);
}

function fileExists(filePath: string): boolean {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function executableCommand(value: string): string {
  if (process.platform === 'win32') {
    const escaped = value.replace(/'/g, "''");
    return `& '${escaped}'`;
  }
  const escaped = value.replace(/'/g, `'"'"'`);
  return `'${escaped}'`;
}

function tail(value: string, maxChars: number): string {
  const text = String(value ?? '');
  return text.length <= maxChars ? text : text.slice(-maxChars);
}
