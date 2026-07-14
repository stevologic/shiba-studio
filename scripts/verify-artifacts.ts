import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

async function officeFixture(filePath: string, entries: Record<string, string>): Promise<void> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-artifacts-'));
  const workspace = path.join(root, 'workspace');
  process.env.SHIBA_DATA_DIR = path.join(root, 'data');
  process.env.SHIBA_SECRET_KEY = '99'.repeat(32);
  await fs.mkdir(workspace, { recursive: true });
  const workspaceAlias = path.join(root, 'workspace-alias');
  await fs.symlink(workspace, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir');

  const files = {
    html: path.join(workspace, 'dashboard.html'),
    pdf: path.join(workspace, 'report.pdf'),
    word: path.join(workspace, 'brief.docx'),
    powerpoint: path.join(workspace, 'deck.pptx'),
    excel: path.join(workspace, 'table.xlsx'),
    image: path.join(workspace, 'pixel.png'),
    svg: path.join(workspace, 'auto.svg'),
  };
  await fs.writeFile(files.html, '<!doctype html><title>Safe</title><script>document.body.append("ready")</script>');
  await fs.writeFile(files.pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
  await fs.writeFile(files.image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  await fs.writeFile(files.svg, '<svg xmlns="http://www.w3.org/2000/svg"><text>one</text></svg>');
  await officeFixture(files.word, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Brief</w:t></w:r></w:p></w:body></w:document>',
  });
  await officeFixture(files.powerpoint, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Slide one</a:t></p:sld>',
  });
  await officeFixture(files.excel, {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Hello</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
  });

  const dbModule = await import('../lib/db');
  const ledger = await import('../lib/task-ledger');
  const checkpoints = await import('../lib/task-checkpoints');
  const artifacts = await import('../lib/artifacts');

  try {
    const db = dbModule.getDb();
    const task = ledger.createTask({
      id: 'artifact-task', kind: 'artifact', title: 'Verify finished outputs', originType: 'manual',
      workspaceRoots: [{ id: 'workspace', path: workspace, permission: 'write' }],
    });
    artifacts.listArtifacts(task.id);
    for (const table of ['artifacts', 'artifact_versions', 'artifact_annotations', 'artifact_publications']) {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { n: number }).n, 1);
    }

    const records = [];
    for (const kind of ['html', 'pdf', 'word', 'powerpoint', 'excel', 'image'] as const) {
      const artifact = await artifacts.createArtifact({ taskId: task.id, filePath: files[kind] });
      assert.equal(artifact.kind, kind);
      const version = artifact.versions![0];
      assert.equal(checkpoints.getTaskCheckpoint(version.checkpointId, task.id)?.state, 'ready');
      assert.equal((await artifacts.artifactVersionResponse(artifact, version)).status, 200);
      records.push(artifact);
    }
    await assert.rejects(
      () => artifacts.createArtifact({ taskId: task.id, filePath: path.join(root, 'outside.html') }),
      /task-owned writable workspace root/,
    );

    const html = records.find((artifact) => artifact.kind === 'html')!;
    const original = html.versions![0];
    const htmlResponse = await artifacts.artifactVersionResponse(html, original);
    assert.match(htmlResponse.headers.get('content-security-policy') || '', /sandbox allow-scripts/);
    assert.match(htmlResponse.headers.get('content-security-policy') || '', /connect-src 'none'/);
    assert.equal(htmlResponse.headers.get('cache-control'), 'private, no-store');
    assert.match(await htmlResponse.text(), /document\.body/);

    await assert.rejects(
      () => artifacts.createArtifact({ taskId: task.id, filePath: files.html, liveSource: { type: 'filesystem', reference: files.html, readOnly: true, approvedAt: '' } }),
      /explicit read-only approval/,
    );
    const live = await artifacts.createArtifact({
      taskId: task.id, filePath: files.html,
      sourceLineage: { sourcePath: path.join(root, 'spoofed.html'), generator: 'verifier' },
      liveSource: { type: 'filesystem', reference: files.html, readOnly: true, approvedAt: '' },
      approveLiveSource: true,
    });
    assert.equal(live.sourceLineage.sourcePath, await fs.realpath(files.html), 'caller cannot spoof owned source lineage');
    assert(live.liveSource?.approvedAt);
    await fs.writeFile(files.html, '<!doctype html><title>Version two</title>');
    const refreshed = await artifacts.refreshLiveArtifact(live.id);
    assert.equal(refreshed.versions?.length, 2);
    assert.equal(refreshed.status, 'draft');
    await assert.rejects(() => artifacts.createArtifactVersion(live.id), /unchanged/);

    const first = refreshed.versions!.find((version) => version.version === 1)!;
    const second = refreshed.versions!.find((version) => version.version === 2)!;
    const checked = await artifacts.verifyArtifactVersion({ artifactId: live.id, versionId: first.id, passed: true, renderer: 'verifier', notes: 'Visual output checked.', metadata: { pages: 1 } });
    assert.equal(checked.status, 'draft', 'verifying an old version does not bless the pending current version');
    const rolledBack = artifacts.rollbackArtifact(live.id, first.id);
    assert.equal(rolledBack.currentVersionId, first.id);
    assert.equal(rolledBack.status, 'verified');
    assert.notEqual(first.checkpointId, second.checkpointId);

    const annotation = artifacts.addArtifactAnnotation({ artifactId: live.id, versionId: first.id, locator: { type: 'region', x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, comment: 'Move the title.' });
    assert.equal(annotation.status, 'open');
    assert.equal(artifacts.resolveArtifactAnnotation(live.id, annotation.id, true).status, 'resolved');
    assert.throws(() => artifacts.addArtifactAnnotation({ artifactId: live.id, versionId: first.id, locator: { type: 'page', page: 0 }, comment: 'Bad' }), /positive integer/);

    const publication = artifacts.publishArtifact({ artifactId: live.id, versionId: first.id, audience: 'private_link', ttlHours: 1 });
    assert.equal(artifacts.listArtifactPublications(live.id)[0].id, publication.id);
    const resolved = artifacts.resolvePublishedArtifact(publication.token);
    assert.equal(resolved?.version.id, first.id);
    assert.equal(artifacts.publicationAudienceAllowsRequest(resolved!.publication, new Request('https://public.example/artifact')), true);
    assert.equal(artifacts.revokeArtifactPublications(live.id, publication.id), 1);
    assert.equal(artifacts.resolvePublishedArtifact(publication.token), null);

    const lan = artifacts.publishArtifact({ artifactId: live.id, versionId: first.id, audience: 'lan' });
    const lanResolved = artifacts.resolvePublishedArtifact(lan.token)!;
    assert.equal(artifacts.publicationAudienceAllowsRequest(lanResolved.publication, new Request('https://public.example/artifact')), false);
    assert.equal(artifacts.publicationAudienceAllowsRequest(lanResolved.publication, new Request('http://192.168.1.5/artifact')), true);
    assert.equal(artifacts.takeDownArtifact(live.id).status, 'archived');
    assert.equal(artifacts.resolvePublishedArtifact(lan.token), null);

    const automatic = await artifacts.autoRegisterArtifactWrite({ taskId: task.id, filePath: files.svg, runId: 'run-1' });
    assert.equal(automatic?.kind, 'image');
    assert.equal(automatic?.sourceLineage.origin, 'agent_fs_write');
    await fs.writeFile(files.svg, '<svg xmlns="http://www.w3.org/2000/svg"><text>two</text></svg>');
    const automaticV2 = await artifacts.autoRegisterArtifactWrite({
      taskId: task.id,
      filePath: path.join(workspaceAlias, path.basename(files.svg)),
      runId: 'run-1',
    });
    assert.equal(automaticV2?.id, automatic?.id, 'canonical path aliases update the existing artifact');
    assert.equal(automaticV2?.versions?.length, 2);

    const tamperVersion = automaticV2!.versions![0];
    await fs.chmod(tamperVersion.filePath, 0o666).catch(() => {});
    await fs.writeFile(tamperVersion.filePath, 'tampered');
    assert.equal((await artifacts.artifactVersionResponse(automaticV2!, tamperVersion)).status, 409);

    const evidence = ledger.getTaskDetails(task.id)!.evidence;
    assert(evidence.some((item) => item.kind === 'artifact' && item.status === 'passed' && item.metadata.versionId === first.id));
    assert(evidence.some((item) => item.metadata.annotationId === annotation.id && item.metadata.revisionContext === true));
    const previewSource = await fs.readFile(path.join(process.cwd(), 'components', 'artifact-preview.tsx'), 'utf8');
    assert.match(previewSource, /docx-preview/);
    assert.match(previewSource, /import\('jszip'\)/);
    assert.match(previewSource, /sandbox="allow-scripts"/);
    const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    assert(!pkg.dependencies?.xlsx, 'the vulnerable xlsx package is not installed');

    console.log('ARTIFACTS_OK formats=html+pdf+docx+pptx+xlsx+image immutable=checkpointed review=evidence annotations=anchored publish=revocable live=read-only');
  } finally {
    dbModule.closeDb();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
