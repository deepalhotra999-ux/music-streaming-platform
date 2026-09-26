// Release tooling — Releases page.
//
// Two jobs: (1) a "Deploy" action that asks the API to fire a
// repository_dispatch event to GitHub Actions (the workflow does the real
// build/verify/deploy — this console never uploads code); (2) a read-only
// table of recent workflow runs.
//
// When the API reports 503 the deploy integration is not configured and the
// page renders setup instructions instead of a dead button.

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { listDeployRuns, triggerDeploy } from '../api/releases';
import type { DeployRun } from '../api/releases';
import { ApiError } from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { formatDate } from '../utils/format';

type RunsState =
  | { kind: 'loading' }
  | { kind: 'ready'; runs: DeployRun[] }
  | { kind: 'unconfigured' }
  | { kind: 'error'; error: unknown };

function toRunsState(error: unknown): RunsState {
  if (error instanceof ApiError && error.status === 503) {
    return { kind: 'unconfigured' };
  }
  return { kind: 'error', error };
}

function conclusionLabel(run: DeployRun): string {
  if (run.status !== 'completed') return run.status ?? 'unknown';
  return run.conclusion ?? 'unknown';
}

export function ReleasesPage(): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [runsState, setRunsState] = useState<RunsState>({ kind: 'loading' });
  const [refInput, setRefInput] = useState('main');
  const [deploying, setDeploying] = useState(false);
  const [deployNotice, setDeployNotice] = useState<string | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRunsState({ kind: 'loading' });
    try {
      const { data } = await listDeployRuns(client);
      setRunsState({ kind: 'ready', runs: data });
    } catch (error) {
      setRunsState(toRunsState(error));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDeploy(event: FormEvent): Promise<void> {
    event.preventDefault();
    const ref = refInput.trim() || 'main';
    const ok = await confirm({
      title: 'Trigger deployment?',
      message:
        `This fires the CD workflow for "${ref}" (build, verify, deploy). ` +
        'Use it after pushing the changes you want released.',
      confirmLabel: 'Deploy',
    });
    if (!ok) return;
    setDeploying(true);
    setDeployNotice(null);
    setDeployError(null);
    try {
      const result = await triggerDeploy(client, ref);
      setDeployNotice(
        `Deploy requested for "${result.ref}". Watch it land in the runs table below.`,
      );
      // Refresh the runs list so the new run appears (GitHub may take a few
      // seconds to register it; the list still shows the latest known state).
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) {
        setRunsState({ kind: 'unconfigured' });
        setDeployError(
          'Deployments are not configured on the API (GITHUB_DEPLOY_TOKEN). See the setup notes below.',
        );
      } else {
        setDeployError(error instanceof Error ? error.message : 'The deploy request failed.');
      }
    } finally {
      setDeploying(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Releases</h1>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Trigger deployments and watch GitHub Actions build, verify, and ship them. The console never
        uploads code — it only asks the API to dispatch the CD workflow.
      </p>

      <section className="card" aria-label="Trigger deployment">
        <h2>Deploy</h2>
        <form onSubmit={(event) => void handleDeploy(event)} className="toolbar">
          <div className="field">
            <label htmlFor="deploy-ref">Branch or tag</label>
            <input
              id="deploy-ref"
              type="text"
              value={refInput}
              onChange={(event) => setRefInput(event.target.value)}
              placeholder="main"
              maxLength={100}
              disabled={deploying}
            />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button type="submit" className="btn btn-primary" disabled={deploying}>
              {deploying ? 'Dispatching…' : 'Deploy'}
            </button>
          </div>
        </form>
        {deployNotice ? (
          <p role="status" style={{ color: 'var(--color-success, #2f9e44)' }}>
            {deployNotice}
          </p>
        ) : null}
        {deployError ? (
          <p className="error-text" role="alert">
            {deployError}
          </p>
        ) : null}
      </section>

      <section className="card" aria-label="Recent workflow runs" style={{ marginTop: 16 }}>
        <h2>Recent runs</h2>
        {runsState.kind === 'loading' ? <LoadingState /> : null}
        {runsState.kind === 'error' ? (
          <ErrorState error={runsState.error} onRetry={() => void load()} />
        ) : null}
        {runsState.kind === 'unconfigured' ? (
          <div>
            <p>
              The API has no <code>GITHUB_DEPLOY_TOKEN</code> configured, so run history is
              unavailable. To enable it:
            </p>
            <ol>
              <li>
                Create a fine-grained personal access token with{' '}
                <strong>Actions: read and write</strong> on{' '}
                <code>deepalhotra999-ux/music-streaming-platform</code>.
              </li>
              <li>
                Set <code>GITHUB_DEPLOY_TOKEN</code> in the API environment and restart the API.
              </li>
              <li>Reload this page.</li>
            </ol>
            <p className="muted" style={{ fontSize: 13 }}>
              The token lives on the server only — it is never shown in this console. Full
              instructions: <code>docs/RELEASES.md</code>.
            </p>
          </div>
        ) : null}
        {runsState.kind === 'ready' ? (
          runsState.runs.length === 0 ? (
            <EmptyState message="No workflow runs yet." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Branch</th>
                  <th>Status</th>
                  <th>Event</th>
                  <th>Started</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {runsState.runs.map((run) => (
                  <tr key={run.id}>
                    <td>#{run.runNumber}</td>
                    <td>{run.headBranch ?? '—'}</td>
                    <td>
                      <span className="badge">{conclusionLabel(run)}</span>
                    </td>
                    <td>{run.event}</td>
                    <td>{formatDate(run.createdAt)}</td>
                    <td>
                      <a href={run.htmlUrl} target="_blank" rel="noreferrer">
                        View on GitHub
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </section>
      {dialog}
    </div>
  );
}
