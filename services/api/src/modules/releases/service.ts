// Release tooling — admin-triggered deploys via GitHub Actions.
//
// SECURITY MODEL (read this before touching this file):
// The admin panel never executes code on the server. POST /v1/admin/deploy
// only fires a `repository_dispatch` event to GitHub; the `cd.yml` workflow
// does the real work (checkout, build, verify, deploy). This keeps arbitrary
// code execution out of the admin surface by construction.
//
// The GitHub token lives in server env (GITHUB_DEPLOY_TOKEN). It is sent to
// api.github.com only, and is never logged, never returned to clients, and
// never written to the audit log. Audit rows record facts (ref, event type)
// only.

import { HttpProblem } from '../../http/errors.js';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
/** Event type the cd.yml workflow listens for. */
export const DEPLOY_EVENT_TYPE = 'deploy-requested';

export interface GitHubDeployConfig {
  /** Fine-grained PAT with Actions:write. Null when not configured. */
  token: string | null;
  /** "owner/name" of the repo receiving the dispatch. */
  repo: string;
}

export class DeployNotConfiguredError extends Error {
  constructor() {
    super('Deployments are not configured.');
    this.name = 'DeployNotConfiguredError';
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'waveform-api',
  };
}

export interface TriggerDeployResult {
  ref: string;
  eventType: string;
}

/**
 * Fires a repository_dispatch event so GitHub Actions runs the CD workflow
 * for `ref`. Throws DeployNotConfiguredError when the token is missing, or
 * HttpProblem(502) when GitHub rejects the dispatch.
 */
export async function triggerDeploy(
  ref: string,
  config: GitHubDeployConfig,
  fetchFn: typeof fetch = fetch,
): Promise<TriggerDeployResult> {
  if (!config.token) {
    throw new DeployNotConfiguredError();
  }
  const res = await fetchFn(`${GITHUB_API}/repos/${config.repo}/dispatches`, {
    method: 'POST',
    headers: { ...githubHeaders(config.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: DEPLOY_EVENT_TYPE,
      client_payload: { ref },
    }),
  });
  if (res.status !== 204) {
    throw new HttpProblem(502, 'Bad Gateway', `GitHub rejected the deploy dispatch (status ${res.status}).`, {
      type: 'https://api.music-streaming.local/problems/deploy-dispatch-failed',
    });
  }
  return { ref, eventType: DEPLOY_EVENT_TYPE };
}

export interface DeployRun {
  id: number;
  runNumber: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  headBranch: string | null;
  event: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

/**
 * Lists the 20 most recent workflow runs for the repo (newest first).
 * Read-only; used by the admin Releases page.
 */
export async function listDeployRuns(
  config: GitHubDeployConfig,
  fetchFn: typeof fetch = fetch,
): Promise<DeployRun[]> {
  if (!config.token) {
    throw new DeployNotConfiguredError();
  }
  const res = await fetchFn(`${GITHUB_API}/repos/${config.repo}/actions/runs?per_page=20`, {
    headers: githubHeaders(config.token),
  });
  if (!res.ok) {
    throw new HttpProblem(502, 'Bad Gateway', `GitHub rejected the runs request (status ${res.status}).`, {
      type: 'https://api.music-streaming.local/problems/deploy-runs-failed',
    });
  }
  const json = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> };
  return (json.workflow_runs ?? []).map((run) => ({
    id: Number(run.id),
    runNumber: Number(run.run_number),
    name: typeof run.name === 'string' ? run.name : null,
    status: typeof run.status === 'string' ? run.status : null,
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    headBranch: typeof run.head_branch === 'string' ? run.head_branch : null,
    event: typeof run.event === 'string' ? run.event : '',
    createdAt: typeof run.created_at === 'string' ? run.created_at : '',
    updatedAt: typeof run.updated_at === 'string' ? run.updated_at : '',
    htmlUrl: typeof run.html_url === 'string' ? run.html_url : '',
  }));
}
