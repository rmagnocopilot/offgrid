const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { buildJavaCoveragePlan, parseJacocoXml, summarizeJacocoXml } = require('../out/coverage/JavaCoverage');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<report name="app">
  <package name="br/gov/caixa/siavo/service">
    <class name="br/gov/caixa/siavo/service/TarifaService" sourcefilename="TarifaService.java">
      <method name="calcular" desc="()V" line="10">
        <counter type="INSTRUCTION" missed="4" covered="8"/>
        <counter type="BRANCH" missed="1" covered="1"/>
        <counter type="LINE" missed="1" covered="3"/>
        <counter type="COMPLEXITY" missed="1" covered="1"/>
      </method>
      <method name="calcularEspecial" desc="()V" line="30">
        <counter type="INSTRUCTION" missed="12" covered="0"/>
        <counter type="BRANCH" missed="2" covered="0"/>
        <counter type="LINE" missed="4" covered="0"/>
        <counter type="COMPLEXITY" missed="2" covered="0"/>
      </method>
      <method name="calcularNormal" desc="()V" line="50">
        <counter type="INSTRUCTION" missed="0" covered="9"/>
        <counter type="BRANCH" missed="0" covered="2"/>
        <counter type="LINE" missed="0" covered="3"/>
        <counter type="COMPLEXITY" missed="0" covered="1"/>
      </method>
    </class>
  </package>
</report>`;

test('parser JaCoCo identifica métodos sem cobertura e parcialmente cobertos', () => {
  const classes = parseJacocoXml(XML);
  assert.equal(classes.length, 1);
  assert.equal(classes[0].methods.length, 3);
  const summary = summarizeJacocoXml(XML, 'TarifaService');
  assert.equal(summary.methodsTotal, 3);
  assert.equal(summary.methodsFullyCovered, 1);
  assert.equal(summary.methodsPartiallyCovered, 1);
  assert.equal(summary.methodsUncovered, 1);
  assert.equal(summary.uncoveredMethods[0].name, 'calcularEspecial');
  assert.equal(summary.partialMethods[0].name, 'calcular');
  assert.equal(summary.partialMethods[0].missedBranches, 1);
});

test('plano Maven usa JaCoCo existente sem alterar pom.xml', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-jacoco-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = 'app/src/main/java/com/example/TarifaService.java';
  await fsp.mkdir(path.join(root, 'app/src/main/java/com/example'), { recursive: true });
  await fsp.writeFile(path.join(root, source), 'package com.example; public class TarifaService {}', 'utf8');
  await fsp.writeFile(path.join(root, 'app/pom.xml'), '<project><build><plugins><plugin><groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId></plugin></plugins></build></project>', 'utf8');
  const plan = await buildJavaCoveragePlan(root, source);
  assert.equal(plan.buildSystem, 'maven');
  assert.equal(plan.configured, true);
  assert.equal(plan.moduleRoot, 'app');
  assert.match(plan.command, /test jacoco:report/);
  assert.ok(plan.reportCandidates.some(value => value.endsWith(path.join('target', 'site', 'jacoco', 'jacoco.xml'))));
});

test('plano de cobertura recusa adicionar JaCoCo automaticamente quando build não está configurado', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-jacoco-no-plugin-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = 'src/main/java/com/example/TarifaService.java';
  await fsp.mkdir(path.join(root, 'src/main/java/com/example'), { recursive: true });
  await fsp.writeFile(path.join(root, source), 'package com.example; public class TarifaService {}', 'utf8');
  await fsp.writeFile(path.join(root, 'pom.xml'), '<project/>', 'utf8');
  const plan = await buildJavaCoveragePlan(root, source);
  assert.equal(plan.configured, false);
  assert.match(plan.reason, /não possui configuração JaCoCo/i);
});
