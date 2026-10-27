import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire, registerHooks} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {render} from './build.mjs';
import {loadRecipe} from '../../src/build.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = process.env.DSH_PACKAGE_ROOT;
if (!packageRoot) throw new Error('Set DSH_PACKAGE_ROOT to an installed @deepseek-ai/dsh directory (see docs/harnesses/dsh.md)');
const requireDsh = createRequire(path.join(packageRoot, 'package.json'));
const sdk = async name => import(pathToFileURL(requireDsh.resolve(`@deepseek-ai/${name}`)).href);
const {Context} = await sdk('cordis');
const {default: Loader} = await sdk('cordis-plugin-loader');
const {loadProfile, composeEntries, healProfilesModuleFallback} = await sdk('dsh-app-boot');
const {createUserMessage} = await sdk('dsh-llm');
const {SessionId} = await sdk('dsh-session');
const {agentEvents, assembleContextFor} = await sdk('dsh-agent');
const {renderPrompt} = await sdk('dsh-system-prompt');
const recipe = await loadRecipe(root);
const outputs = await render({root, ...recipe});
const text = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('');
const message = (kind, body = kind, fields = {}) => createUserMessage({source: {kind, ...fields}, content: [{type: 'text', text: body}]});
const sessionEvents = session => session.snapshotEvents ? session.snapshotEvents() : session.events;

// 0.1.x projects the installation closure into the fixture home; 0.2.x dropped that
// helper and installs a runtime resolver instead, so the fixture supplies its own.
let sdkResolution;
function resolveSdkInstallation(home) {
  if (healProfilesModuleFallback) return healProfilesModuleFallback(path.join(packageRoot, 'package.json'), home);
  sdkResolution ??= registerHooks({
    resolve(specifier, context, next) {
      if (!specifier.startsWith('@deepseek-ai/')) return next(specifier, context);
      try { return {url: pathToFileURL(requireDsh.resolve(specifier)).href, shortCircuit: true}; }
      catch { return next(specifier, context); }
    },
  });
}

async function fixture(t, rootRole = 'main') {
  const tempRoot = path.join(root, '.tmp');
  await fs.mkdir(tempRoot, {recursive: true});
  const home = await fs.mkdtemp(path.join(tempRoot, 'dsh-native-'));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  resolveSdkInstallation(home);
  const profile = path.join(home, 'profiles', 'fixture');
  const bundleDir = path.join(profile, 'node_modules', 'dsh-gpt-with-taste');
  await fs.mkdir(bundleDir, {recursive: true});
  for (const [file, bytes] of outputs) await fs.writeFile(path.join(bundleDir, file), bytes);
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({dsh: {profile: {bundles: ['dsh-gpt-with-taste']}}}));
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), `- id: gpt-with-taste\n  config:\n    rootRole: ${rootRole}\n`);
  const native = loadProfile('dsh', 'fixture', path.join(packageRoot, 'package.json'), home);
  assert.equal(native.layers[0].packageDir, bundleDir);
  const rows = composeEntries([...native.layers.map(layer => layer.patches), native.patches]);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader, {baseUrl: pathToFileURL(profile + path.sep).href});
  // 0.2.x's agent loop also injects `sessionProjections`; 0.1.x has no such package.
  const services = ['dsh-llm', 'dsh-session', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-session-projection', 'dsh-agent-loop']
    .filter(name => { try { requireDsh.resolve(`@deepseek-ai/${name}`); return true; } catch { return false; } });
  for (const name of services) {
    await ctx.loader.create({
      name: pathToFileURL(requireDsh.resolve(`@deepseek-ai/${name}`)).href,
      // 0.2.x renamed the persona config to personaPrefix and exposes events via snapshotEvents().
      config: name === 'dsh-agent-loop' ? {agents: []} : name === 'dsh-system-prompt' ? {persona: 'HOST PERSONA', personaPrefix: 'HOST PERSONA'} : {},
    });
  }
  await ctx.loader.root.update([...ctx.loader.root.data, ...rows]);
  await ctx.loader.await();
  assert.equal(ctx.loader.resolve('gpt-with-taste').fiber.state, 2); // Cordis FiberState.ACTIVE
  ctx.systemPrompt.section({name: 'host:environment', order: 2, text: 'HOST ENVIRONMENT'});
  ctx.systemPrompt.context({name: 'host:AGENTS', order: 1, text: 'HOST AGENTS'});
  const makeAgent = async (id, origin) => (await ctx.agents.create({
    sessionId: SessionId(id), meta: origin ? {origin} : {},
    agentOptions: {provider: 'unchanged-provider', model: 'unchanged-model', maxTokens: 321},
  })).agent;
  const step = (agent, messages) => agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages, turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => ({kind: 'enter', messages}));
  return {ctx, makeAgent, step, bundleDir};
}

test('native bundle discovery, Loader apply, prompt augmentation and clean unload', async t => {
  const {ctx, makeAgent, step} = await fixture(t);
  const main = await makeAgent('main');
  const sub = await makeAgent('sub', 'subagent');
  for (const [agent, key] of [[main, 'main'], [sub, 'sub']]) {
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent));
    assert.equal(assembly.sections.filter(section => section.name === 'gpt-with-taste:behavior').length, 1);
    assert.equal(assembly.sections.find(section => section.name === 'gpt-with-taste:behavior').text, recipe.texts[key]);
    assert.match(renderPrompt(assembly), /HOST PERSONA/);
    assert.match(renderPrompt(assembly), /HOST ENVIRONMENT/);
    assert.equal(assembly.contexts.find(context => context.name === 'host:AGENTS').text, 'HOST AGENTS');
    assert.deepEqual(agent.options, {provider: 'unchanged-provider', model: 'unchanged-model', maxTokens: 321});
  }
  const user = message('user');
  await ctx.loader.remove('gpt-with-taste');
  assert.ok(!(await ctx.systemPrompt.assemble(assembleContextFor(main))).sections.some(section => section.name === 'gpt-with-taste:behavior'));
  assert.deepEqual((await step(main, [user])).messages, [user]);
});

test('typed input sources get one preceding instruction; originals, rejections and tools survive', async t => {
  const {ctx, makeAgent, step} = await fixture(t);
  const main = await makeAgent('main');
  const sub = await makeAgent('sub', 'subagent');
  const cases = [
    [main, message('user'), 'userSteer'],
    [sub, message('user'), 'subSteer'],
    [sub, message('coordinator', 'parent instruction', {form: 'relay', senderSessionId: 'parent'}), 'subSteer'],
    [main, message('agent-message', 'adjacent message', {form: 'relay', senderSessionId: 'child'}), 'agentSteer'],
    [sub, message('agent-message', 'adjacent message', {form: 'relay', senderSessionId: 'child'}), 'subSteer'],
    [main, message('subagent-report', 'partial report', {form: 'relay', senderSessionId: 'child'}), 'agentSteer'],
    [sub, message('subagent-settled', 'child failed', {form: 'notice', summary: 'Child failed', senderSessionId: 'child'}), 'subSteer'],
    [sub, message('subagent-report', 'nested report', {form: 'relay', senderSessionId: 'child'}), 'subSteer'],
  ];
  for (const [agent, original, key] of cases) {
    const result = await step(agent, [original]);
    assert.equal(result.messages.length, 2);
    assert.equal(text(result.messages[0]), recipe.texts[key]);
    assert.equal(result.messages[1], original);
    assert.deepEqual(result.messages[0].source, {kind: 'plugin:gpt-with-taste', form: 'instructions'});
  }
  const opaque = [message('plugin', 'ordinary context', {plugin: 'host'}), message('extension-defined', 'unclassified'), message('tool', 'normal tool continuation', {callId: 'tool-call'})];
  assert.deepEqual((await step(main, opaque)).messages, opaque);
  assert.deepEqual((await step(main, [])).messages, []);
  const mixed = [cases[0][1], cases[3][1], ...opaque];
  const result = await step(main, mixed);
  assert.equal(result.messages.length, mixed.length + 2);
  assert.equal(result.messages[1], mixed[0]);
  assert.equal(result.messages[3], mixed[1]);
  assert.deepEqual((await step(main, result.messages.filter(m => m.source.kind === 'plugin'))).messages, result.messages.filter(m => m.source.kind === 'plugin'));
  const reject = ctx.on('agent/pre-step', async (_payload, next) => { await next(); return {kind: 'reject'}; });
  assert.deepEqual(await step(main, [cases[0][1]]), {kind: 'reject'});
  reject();
});

test('explicit independent root retains native subagent identity and disables root steering', async t => {
  const {ctx, makeAgent, step} = await fixture(t, 'independent');
  const independent = await makeAgent('independent');
  const child = await makeAgent('child', 'subagent');
  assert.equal((await ctx.systemPrompt.assemble(assembleContextFor(independent))).sections.find(s => s.name === 'gpt-with-taste:behavior').text, recipe.texts.independent);
  const input = message('user');
  assert.deepEqual((await step(independent, [input])).messages, [input]);
  assert.equal(text((await step(child, [input])).messages[0]), recipe.texts.subSteer);
});

test('real send/steer/inject/followup claim path logs instructions without extra wakes or model calls', async t => {
  const {ctx, makeAgent} = await fixture(t);
  const agent = await makeAgent('live');
  const other = await makeAgent('other');
  const claims = [];
  const transitions = [];
  ctx.on('agent/inbox/claimed', ({agent: owner, message}) => claims.push([owner.id, message.id]));
  ctx.on('agent/status', ({agent: owner, status}) => transitions.push([owner.id, status]));
  // The real loop commits pre-step user/message events, then stops before resolving any model/provider.
  const stopped = new Error('fixture: stop before model request');
  ctx.on('agent/request', async (_payload, next) => { await next(); throw stopped; });
  const errors = [];
  ctx.on('agent/error', payload => errors.push(payload.error));
  const quiet = message('subagent-report', 'quiet child report', {form: 'relay', senderSessionId: 'child'});
  agent.inject(quiet);
  assert.equal(agent.status, 'idle');
  assert.equal(claims.length, 0);
  assert.equal(transitions.length, 0);
  const user = message('user', 'original user');
  agent.followup(user);
  await agent.whenIdle();
  const logged = sessionEvents(agent.session).filter(event => event.type === 'user/message').map(event => event.data);
  assert.equal(claims.filter(([id]) => id === agent.id).length, 2);
  if (logged.length === 0) {
    // 0.2.x commits prompt messages to the session surface and records inbound input as
    // `agent/inbox/spliced`; a detached fixture session has no surface to read back.
    const spliced = sessionEvents(agent.session).filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data?.inserted ?? []);
    assert.deepEqual(spliced.map(text), ['quiet child report', 'original user']);
  } else {
    assert.deepEqual(logged.map(text).filter(value => value !== 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nHOST AGENTS'), [recipe.texts.agentSteer, 'quiet child report', recipe.texts.userSteer, 'original user']);
    assert.equal(logged.find(value => value.id === user.id).content[0].text, 'original user');
  }
  assert.deepEqual(sessionEvents(other.session).filter(event => event.type === 'user/message'), []);
  assert.equal(errors.length, 1);
  assert.deepEqual(transitions, [[agent.id, 'running'], [agent.id, 'idle']]);

  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const pause = ctx.on('agent/pre-step', async (_payload, next) => {
    entered.resolve();
    await release.promise;
    return next();
  });
  agent.steer(message('user', 'nearest step'));
  await entered.promise;
  assert.equal(agent.status, 'running');
  agent.inject(message('plugin', 'non-waking context', {plugin: 'host'}));
  agent.send(message('user', 'running steer'), 'next-step', false);
  assert.equal(transitions.filter(([, status]) => status === 'running').length, 2);
  release.resolve();
  await agent.whenIdle();
  pause();
  assert.equal(agent.status, 'idle');
  assert.equal(transitions.filter(([, status]) => status === 'running').length, 2);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => error === stopped));
});

test('agent-scoped installation stays local and unwinds with its fiber', async t => {
  const {ctx, makeAgent, step, bundleDir} = await fixture(t);
  await ctx.loader.remove('gpt-with-taste');
  const chosen = await makeAgent('chosen');
  const sibling = await makeAgent('sibling');
  const plugin = await import(pathToFileURL(path.join(bundleDir, 'index.mjs')).href);
  const fiber = await chosen.ctx.plugin(plugin, {rootRole: 'main'});
  const behavior = agent => ctx.systemPrompt.assemble(assembleContextFor(agent)).then(value => value.sections.find(section => section.name === 'gpt-with-taste:behavior'));
  assert.equal((await behavior(chosen)).text, recipe.texts.main);
  assert.equal(await behavior(sibling), undefined);
  const input = message('user');
  assert.equal(text((await step(chosen, [input])).messages[0]), recipe.texts.userSteer);
  assert.deepEqual((await step(sibling, [input])).messages, [input]);
  await fiber.dispose();
  assert.equal(await behavior(chosen), undefined);
  assert.deepEqual((await step(chosen, [input])).messages, [input]);
});
