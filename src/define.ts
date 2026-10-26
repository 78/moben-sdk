import type { AppDefinition } from './types';
import { REMOTE_PROTOCOL_VERSION, validateHello } from './core/remote-hello';

/** The app.hello parameters the cloud validates when the app connects. */
export function helloParams(app: AppDefinition) {
  return {
    protocol: REMOTE_PROTOCOL_VERSION,
    manifest: app.manifest,
    routes: {
      pages: Object.keys(app.pages), actions: Object.keys(app.actions ?? {}), progress: Object.keys(app.progress ?? {}),
      voice: Object.entries(app.voice ?? {}).map(([route, entry]) => ({ route, input: entry?.input }))
    }
  };
}

/**
 * Checks a remote app definition with the same rules the cloud applies when the
 * app connects, and returns it unchanged. `manifest.id` is your own ID for the
 * app, unique within your account, such as "computer-status".
 */
export function defineApp<T extends AppDefinition>(app: T): T {
  const issues = validateHello(helloParams(app), { namespace: 'local' }).issues;
  const declared = new Set((app.manifest.agent?.tools ?? []).map(tool => tool.name));
  for (const name of declared) if (typeof app.tools?.[name] !== 'function') issues.push(`tool ${name}: add a handler to tools.${name}`);
  for (const name of Object.keys(app.tools ?? {})) if (!declared.has(name)) issues.push(`tools.${name} is not declared in manifest.agent.tools`);
  for (const [route, entry] of Object.entries(app.voice ?? {})) if (typeof entry?.handler !== 'function') issues.push(`voice ${route}: add a handler`);
  if (issues.length) throw new Error(`Invalid app definition:${issues.map(issue => `\n  - ${issue}`).join('')}`);
  return app;
}
