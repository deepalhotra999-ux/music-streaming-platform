// Release tooling — admin deploy surface client.
//
// POST /v1/admin/deploy only *requests* a deployment: the API fires a
// repository_dispatch event and GitHub Actions does the real work. The admin
// console never uploads code and never sees the GitHub token (it lives in
// server env). Both endpoints fail closed with 503 when the token is not
// configured — the Releases page renders setup instructions in that case.

import type { ApiClient } from './client';

export interface DeployDispatch {
  dispatched: boolean;
  ref: string;
  eventType: string;
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

export function triggerDeploy(client: ApiClient, ref?: string): Promise<DeployDispatch> {
  return client.post<DeployDispatch>('/v1/admin/deploy', ref ? { ref } : {});
}

export function listDeployRuns(client: ApiClient): Promise<{ data: DeployRun[] }> {
  return client.get<{ data: DeployRun[] }>('/v1/admin/deploy/runs');
}
