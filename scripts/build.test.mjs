import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile, loadRecipe, TARGETS, TEXT_KEYS} from '../src/build.mjs';
import {run} from './build.mjs';
import {run as install} from './install.mjs';
import {pluginBundle, MARKET_ROOT} from '../src/codex-plugin.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const scratch = path.join(repo, '.tmp/build-test');
  await fs.mkdir(scratch, {recursive: true});
  const root = await fs.mkdtemp(path.join(scratch, 'case-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  for (const dir of ['recipe', 'adapters', 'src'])
    await fs.cp(path.join(repo, dir), path.join(root, dir), {recursive: true});
  await fs.copyFile(path.join(repo, 'LICENSE'), path.join(root, 'LICENSE'));
  return root;
}
const content = (map, file) => map.get(file).toString();

test('author package is complete, host-neutral and position-specific', async () => {
  const {meta, texts} = await loadRecipe(repo);
  assert.equal(meta.version, '0.1.0');
  assert.equal(meta.compatibility.kiki.version, '1.0.7');
  assert.deepEqual(Object.keys(texts), TEXT_KEYS);
  for (const text of Object.values(texts)) {
    assert.doesNotMatch(text, /current Codex|@variant/);
    assert.match(text, /user's (?:latest language|chosen persona|explicit persona)/);
  }
  assert.match(texts.main, /Own the result the user is trying to achieve/);
  assert.match(texts.main, /Even after a review or tests pass/);
  assert.match(texts.main, /documentation, metrics, or behavior were redefined/);
  assert.match(texts.sub, /parent owns cross-task coordination/);
  assert.match(texts.sub, /leaf status/);
  assert.doesNotMatch(texts.independent, /parent|assigned to you|delegated agent|you are a subagent/i);
  assert.match(texts.independent, /actual controller/);
  for (const key of ['main', 'sub']) {
    assert.match(texts[key], /falsifiable/);
    assert.match(texts[key], /ISO 24495-1:2023/);
    assert.match(texts[key], /entry points, data meaning, and conditions/);
    assert.match(texts[key], /Nonessential hash verification is prohibited/);
  }
});

test('compile is deterministic and each generated file has a source manifest', async () => {
  const first = await compile(repo), second = await compile(repo, [...TARGETS].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual([...first.keys()], [...first.keys()].sort());
  for (const target of TARGETS) {
    const manifestPath = `dist/${target}/build-manifest.json`;
    const manifest = JSON.parse(content(first, manifestPath));
    assert.equal(manifest.recipe.manifest, 'recipe/manifest.json');
    assert.deepEqual(Object.keys(manifest.sources), TEXT_KEYS);
    assert.deepEqual(manifest.files, [...first.keys()].filter(file => file.startsWith(`dist/${target}/`) ||
      (target === 'codex' && file.startsWith('prompts/'))));
    for (const file of manifest.files) assert.ok(first.has(file), file);
  }
  for (const name of ['main', 'sub', 'user-steer', 'sub-steer', 'agent-steer'])
    assert.equal(first.get(`prompts/${name}.md`), first.get(`dist/codex/${name}.md`));
});

test('check detects manual and source drift, remains read-only and respects selected targets', async t => {
  const root = await fixture(t);
  await run([], root);
  await run(['--check'], root);
  const source = path.join(root, 'recipe/main.md'), before = await fs.readFile(source);
  const output = path.join(root, 'dist/kiki/main.md');
  await fs.appendFile(output, '\nMANUAL DRIFT\n');
  await assert.rejects(run(['--check', '--target', 'kiki'], root), /dist\/kiki\/main.md/);
  await run(['--check', '--target', 'codex'], root);
  assert.deepEqual(await fs.readFile(source), before);
  assert.match(await fs.readFile(output, 'utf8'), /MANUAL DRIFT/);
  await run(['--target', 'kiki'], root);
  await fs.appendFile(source, '\nSOURCE CHANGE\n');
  await assert.rejects(run(['--check'], root), /prompts\/main.md/);
  await run(['--target', 'codex'], root);
  await run(['--check', '--target', 'codex'], root);
  await assert.rejects(run(['--check', '--target', 'kiki'], root), /dist\/kiki\/main.md/);
  await run(['--target', 'kiki'], root);
  if (TARGETS.some(target => !['codex', 'kiki'].includes(target)))
    await assert.rejects(run(['--check'], root), /Generated files have drifted/);
  await run([], root);
  await run(['--check'], root);
});

test('one source edit reaches every implemented target and only its corresponding Markdown projections', async t => {
  const root = await fixture(t);
  const before = await compile(root);
  await fs.appendFile(path.join(root, 'recipe/main.md'), '\nONE SOURCE CHANGE\n');
  const after = await compile(root);
  for (const target of TARGETS) {
    const changed = [...after.keys()].filter(file => file.startsWith(`dist/${target}/`) &&
      !Buffer.from(before.get(file)).equals(Buffer.from(after.get(file))));
    assert.ok(changed.length, target);
    for (const file of changed) assert.match(content(after, file), /ONE SOURCE CHANGE/);
    if (target === 'codex' || target === 'kiki')
      assert.ok(changed.every(file => file.endsWith('main.md')), changed.join(', '));
  }
  assert.match(content(after, 'prompts/main.md'), /ONE SOURCE CHANGE/);
  assert.equal(after.get('prompts/sub.md'), before.get('prompts/sub.md'));
});

test('Kiki schema v1 keeps whole-branch isolation, all Steers and the four legacy aliases', async () => {
  const files = await compile(repo, ['kiki']);
  const packages = [...files.keys()].filter(file => file.endsWith('.toml'));
  // Assert the declared branch contracts without adding a parser dependency to Node-only tests.
  const section = (text, name) => {
    const start = text.indexOf(`[${name}]\n`);
    assert.notEqual(start, -1, name);
    return text.slice(start + name.length + 3).split('\n[')[0];
  };
  for (const file of packages) {
    const text = content(files, file), base = path.posix.dirname(file);
    assert.match(text, /schema_version = 1\n/);
    assert.ok(text.includes(`version = "${file.includes('/sol-astra/') ? '1.0.7' : '0.1.0'}"`));
    const common = section(text, 'prompts'), main = section(text, 'prompts.main');
    const independent = section(text, 'prompts.independent');
    const readSlot = (body, key) => {
      const match = body.match(new RegExp(`^${key} = \\{ file = "([^"]+)" \\}`, 'm'));
      assert.ok(match, `${file}: ${key}`);
      return content(files, `${base}/${match[1]}`);
    };
    assert.match(readSlot(common, 'system'), /Own the complete result assigned to you/);
    assert.match(readSlot(main, 'system'), /Own the result the user is trying to achieve/);
    assert.match(readSlot(independent, 'system'), /Turn the user's intent/);
    assert.match(readSlot(common, 'steering'), /parent's goal/);
    assert.match(readSlot(main, 'steering'), /user's purpose/);
    assert.match(section(text, 'prompts.steering_sources.agent'), /^mode = "inherit"/);
    for (const source of ['agent', 'task']) {
      const steer = section(text, `prompts.main.steering_sources.${source}`);
      assert.match(steer, /^mode = "custom"/);
      const match = steer.match(/custom = \{ steering = \{ file = "([^"]+)" \}/);
      assert.ok(match);
      assert.match(content(files, `${base}/${match[1]}`), /Reconcile this message or task result/);
      assert.match(steer, /steering_on_turn = true, steering_on_input = true, steering_interval_steps = 0/);
      assert.match(section(text, `prompts.independent.steering_sources.${source}`), /^mode = "off"/);
    }
    assert.match(independent, /steering = "off"/);
    assert.match(independent, /steering_on_turn = false/);
    assert.match(independent, /steering_on_input = false/);
    for (const [, reference] of text.matchAll(/file = "([^"]+)"/g)) assert.ok(files.has(`${base}/${reference}`), reference);
  }
  assert.deepEqual(JSON.parse(content(files, 'dist/kiki/sol-astra/mapping.json')), {schema: 1, models: {
    'axon/gpt-6.1-sol': 'sol.toml',
    'axon/gpt-6-astra': 'astra.toml',
    'axon-for-test/gpt-6-astra': 'astra.toml',
    'axon/gpt-6-astra-text-recovery': 'astra.toml',
  }});
  assert.match(content(files, 'dist/kiki/sol-astra/sol.toml'), /id = "gpt-6.1-sol-behavior"\nname = "GPT-6.1 Sol — 工作方式"/);
  assert.match(content(files, 'dist/kiki/sol-astra/astra.toml'), /id = "gpt-6-astra-behavior"\nname = "GPT-6 Astra — 工作方式"/);
});

test('selected target does not import another adapter; invalid targets and unsafe paths fail', async t => {
  const root = await fixture(t);
  await fs.rm(path.join(root, 'adapters/kiki'), {recursive: true});
  await compile(root, ['codex']);
  await assert.rejects(compile(root, ['unknown']), /Unknown build target/);
  await assert.rejects(run(['--target'], root), /requires an id/);
  await assert.rejects(run(['--typo'], root), /Unknown argument/);
  const unsafe = await fixture(t);
  await fs.writeFile(path.join(unsafe, 'adapters/codex/build.mjs'), 'export async function render() { return new Map([["../escape.md", "escape"]]); }');
  await assert.rejects(compile(unsafe, ['codex']), /invalid or reserved output path/);
});

test('generated compatibility prompts install, check and restore through the existing installer and plugin bundle', async t => {
  const root = await fixture(t);
  await run(['--target', 'codex'], root);
  for (const dir of ['hooks', 'plugin']) await fs.cp(path.join(repo, dir), path.join(root, dir), {recursive: true});
  const bundle = await pluginBundle(root);
  for (const name of ['user', 'sub', 'agent']) assert.deepEqual(
    bundle.get(`${MARKET_ROOT}/plugins/gpt-with-taste/prompts/${name}-steer.md`),
    await fs.readFile(path.join(root, `prompts/${name}-steer.md`)));
  const home = path.join(root, 'isolated-home');
  const services = {sourceIdentity: async () => ({kind: 'unknown'})};
  const call = args => install(['--home', home, ...args], root, services);
  await call(['--skip-update-check']);
  assert.deepEqual(await fs.readFile(path.join(home, 'prompts/gpt-with-taste/main.md')),
    await fs.readFile(path.join(root, 'prompts/main.md')));
  await call(['--check']);
  await call(['--restore']);
  await assert.rejects(fs.access(path.join(home, 'config.toml')), {code: 'ENOENT'});
});

const authorTrace = /<!--\s*Generated from recipe\/|recipe\/manifest\.json|adapters\/[\w-]+\/build\.mjs|Edit recipe\/|node scripts\/build\.mjs|source gpt-with-taste 0\.1\.0/;
const assertCleanContext = value => assert.doesNotMatch(JSON.stringify(value) ?? '', authorTrace);

function assertBehaviorExports(files, {meta, texts}) {
  for (const target of ['codex', 'kiki', 'pi', 'omp'])
    for (const key of TEXT_KEYS)
      assert.equal(content(files, `dist/${target}/${meta.texts[key]}`), texts[key]);
  for (const name of ['main', 'sub', 'user-steer', 'sub-steer', 'agent-steer']) {
    const key = TEXT_KEYS.find(key => meta.texts[key] === `${name}.md`);
    assert.equal(content(files, `prompts/${name}.md`), texts[key]);
  }
  const legacy = 'dist/kiki/sol-astra/';
  for (const pack of meta.compatibility.kiki.packages)
    for (const key of ['main', 'independent']) assert.equal(content(files, legacy + pack[key]), texts[key]);
  for (const [key, name] of Object.entries({sub: 'sol-astra-sub.md', userSteer: 'sol-astra-main-steering.md',
    subSteer: 'sol-astra-sub-steering.md', agentSteer: 'sol-astra-main-agent-steering.md'}))
    assert.equal(content(files, legacy + name), texts[key]);
  for (const key of ['main', 'independent']) assert.equal(content(files, `dist/claude/${meta.texts[key]}`), texts[key]);
  for (const directory of ['plugin', 'prompt-only']) {
    const prefix = `dist/claude/${directory}/`;
    const agent = content(files, prefix + 'agents/taste-worker.md');
    assert.equal(agent.slice(agent.indexOf('\n---\n') + 6), texts.sub);
    assert.equal(content(files, prefix + 'texts/sub.md'), texts.sub);
  }
  for (const key of ['userSteer', 'subSteer', 'agentSteer'])
    assert.equal(content(files, `dist/claude/plugin/texts/${meta.texts[key]}`), texts[key]);
  assert.deepEqual(JSON.parse(content(files, 'dist/dsh/texts.json')), texts);
}

test('model-facing exports contain only complete behavior; provenance stays in sidecars', async () => {
  const recipe = await loadRecipe(repo), files = await compile(repo);
  assertBehaviorExports(files, recipe);
  for (const [file, bytes] of files)
    if ((file.endsWith('.md') && !file.endsWith('/PROVENANCE.md')) || file === 'dist/dsh/texts.json')
      assertCleanContext(bytes.toString());
  for (const target of TARGETS) assert.match(content(files, `dist/${target}/build-manifest.json`), /recipe\/manifest\.json/);
});

test('behavior sources are exported verbatim, including whitespace and literal user comments', async t => {
  const root = await fixture(t), {meta} = await loadRecipe(root), texts = {};
  for (const key of TEXT_KEYS) {
    texts[key] = ` \t\r\n# User-owned ${key}\r\n\r\nKeep this literal: <!-- Generated from my example. -->\r\n  tail\t \r\n\r\n`;
    await fs.writeFile(path.join(root, 'recipe', meta.texts[key]), texts[key]);
  }
  assert.deepEqual((await loadRecipe(root)).texts, texts);
  assertBehaviorExports(await compile(root), {meta, texts});
});

test('actual generated callbacks and simulated provider payloads keep author metadata out of model context', async t => {
  const root = await fixture(t), {texts} = await loadRecipe(root), files = await run([], root);
  const {pathToFileURL} = await import('node:url');
  const moduleAt = relative => import(pathToFileURL(path.join(root, relative)).href);
  const wrapped = (key, tag = 'gpt-with-taste') => `<${tag}>\n${texts[key].trim()}\n</${tag}>`;

  const {handleHook} = await import('../hooks/steer.mjs');
  for (const [event, route, key] of [
    [{hook_event_name: 'UserPromptSubmit'}, 'user', 'userSteer'],
    [{hook_event_name: 'SubagentStart', agent_id: 'child'}, 'sub', 'subSteer'],
    [{hook_event_name: 'PostToolUse', tool_name: 'wait_agent',
      tool_response: {timed_out: false, status: {child: {completed: 'done'}}}}, 'agent', 'agentSteer'],
  ]) {
    const output = handleHook(event, path.join(root, 'prompts'));
    assert.equal(output.hookSpecificOutput.additionalContext, wrapped(key, `gpt-with-taste-${route}-steer`));
    assertCleanContext(output);
  }

  const claude = await moduleAt('dist/claude/plugin/scripts/hook.mjs');
  for (const [event, expected] of [
    [{hook_event_name: 'UserPromptSubmit'}, texts.userSteer],
    [{hook_event_name: 'SubagentStart', agent_type: 'Explore'}, `${texts.sub}\n\n${texts.subSteer}`],
    [{hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_response: {status: 'completed'}}, texts.agentSteer],
  ]) {
    const output = await claude.route(event);
    assert.equal(output.hookSpecificOutput.additionalContext, expected);
    assertCleanContext(output);
  }
  const promptOnly = await moduleAt('dist/claude/prompt-only/scripts/hook.mjs');
  const child = await promptOnly.route({hook_event_name: 'SubagentStart', agent_type: 'Explore'}, {mode: 'prompts'});
  assert.equal(child.hookSpecificOutput.additionalContext, texts.sub);
  assertCleanContext(child);

  // Exercise the emitted runtimes with native callback-shaped inputs, without a model/provider.
  for (const target of ['pi', 'omp']) {
    const runtime = await moduleAt(`dist/${target}/runtime.mjs`);
    for (const role of ['main', 'sub', 'independent']) {
      const callbacks = new Map();
      const api = {on: (name, callback) => callbacks.set(name, callback), registerCommand() {}};
      runtime.createTasteExtension({role, completedResultTypes: ['fixture:completed']})(api);
      const ctx = {model: {provider: 'openai', id: 'gpt-fixture'},
        agent: {kind: role === 'sub' ? 'sub' : 'main'}, sessionManager: {getBranch: () => []}};
      const system = {role: 'system', content: 'HOST', sections: {host: 'HOST'}};
      const user = {role: 'user', content: 'Continue', timestamp: 1};
      const result = target === 'pi'
        ? {role: 'custom', customType: 'fixture:completed', content: 'Result', timestamp: 2}
        : {role: 'custom', customType: 'async-result', attribution: 'agent', content: 'Result', timestamp: 2,
          details: {jobs: [{type: 'task', status: 'completed'}]}};
      let projected;
      if (target === 'pi') {
        projected = callbacks.get('context_with_system')({messages: [system, user, result]}, ctx);
        assert.equal(projected.messages[0].sections.gpt_with_taste, wrapped(role));
      } else {
        const prepared = callbacks.get('before_agent_start')({systemPrompt: ['HOST']}, ctx);
        assert.deepEqual(prepared.systemPrompt, ['HOST', wrapped(role)]);
        assertCleanContext(prepared);
        projected = callbacks.get('context')({messages: [system, user, result]}, ctx);
        const completed = callbacks.get('tool_result')({toolName: 'task', isError: false,
          details: {results: [{exitCode: 0}]}}, ctx);
        assert.deepEqual(completed, role === 'main' ? {additionalContext: texts.agentSteer.trim()} : undefined);
        assertCleanContext(completed);
      }
      const steers = projected.messages.filter(message => message.customType === 'gpt-with-taste:steer');
      const expected = role === 'independent' ? [] : role === 'sub' ? [['sub', 'subSteer']] : [['user', 'userSteer'], ['agent', 'agentSteer']];
      assert.deepEqual(steers.map(message => message.content), expected.map(([route, key]) => wrapped(key, `gpt-with-taste-${route}-steer`)));
      assertCleanContext(projected);
      const payload = callbacks.get('before_provider_request')({payload: {model: 'gpt-fixture', instructions: 'HOST', input: []}}, ctx);
      assert.equal(payload.instructions, `HOST\n\n${wrapped(role)}`);
      assertCleanContext(payload);
    }
  }

  // Minimal SDK boundary stub: run the generated DSH callbacks, retaining their own message construction.
  const sdk = path.join(root, 'dist/dsh/node_modules/@deepseek-ai/dsh-llm');
  await fs.mkdir(sdk, {recursive: true});
  await fs.writeFile(path.join(sdk, 'package.json'), JSON.stringify({type: 'module', exports: './index.mjs'}));
  await fs.writeFile(path.join(sdk, 'index.mjs'), 'export const createUserMessage = value => value;\n');
  const dsh = await moduleAt('dist/dsh/index.mjs');
  for (const role of ['main', 'sub', 'independent']) {
    let section, callback;
    await dsh.apply({systemPrompt: {section: value => { section = value; }},
      on: (_event, value) => { callback = value; }}, {rootRole: role === 'independent' ? 'independent' : 'main'});
    const agent = {session: {header: {origin: role === 'sub' ? 'subagent' : 'main'}}};
    assert.equal(section.text({agent}), texts[role]);
    const input = [{source: {kind: 'user'}, content: [{type: 'text', text: 'Continue'}]},
      {source: {kind: 'subagent-report'}, content: [{type: 'text', text: 'Result'}]}];
    const output = await callback({agent}, async () => ({kind: 'enter', messages: input}));
    const added = output.messages.filter(message => message.source.kind === 'plugin:gpt-with-taste');
    const expected = role === 'independent' ? [] : role === 'sub' ? [texts.subSteer, texts.subSteer] : [texts.userSteer, texts.agentSteer];
    assert.deepEqual(added.map(message => message.content[0].text), expected);
    assertCleanContext({system: section.text({agent}), messages: output.messages});
  }
  assertBehaviorExports(files, {meta: (await loadRecipe(root)).meta, texts});
});
