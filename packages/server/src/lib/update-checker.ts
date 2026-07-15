/**
 * Update checker — compares the running git checkout's HEAD against the public
 * release repo's latest commit, so the frontend can nudge the user to `git pull`.
 *
 * Run once at server startup; the result is persisted into config.json by the
 * caller. Comparison uses commit *timestamps* (not just hashes): when the author
 * runs the private `origin` checkout (local commit newer than the public tip),
 * `remoteDate > localDate` is false, so it never falsely nags to update.
 *
 * The GitHub call is best-effort: on any failure (offline, rate-limited) the
 * previous `remoteHash/remoteDate` are carried over, so a transient outage never
 * clobbers a known-good result or crashes startup.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PUBLIC_REPO_SLUG,
  PUBLIC_REPO_BRANCH,
  PUBLIC_REPO_URL,
  type UpdateStatus,
} from '@littlecycling/shared';

const execFileAsync = promisify(execFile);

/** Read the running checkout's HEAD hash + commit time (ms). Null if not a git repo. */
async function readLocalCommit(cwd: string): Promise<{ hash: string; date: number } | null> {
  try {
    // %H = full sha, %ct = committer date as unix seconds
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%H %ct'], { cwd });
    const [hash, seconds] = stdout.trim().split(/\s+/);
    if (!hash || !seconds) return null;
    return { hash, date: Number(seconds) * 1000 };
  } catch {
    // git missing, or not run from inside a checkout — treat as "unknown"
    return null;
  }
}

/** Fetch the public repo's latest commit on its default branch. Null on any error. */
async function fetchRemoteCommit(): Promise<{ hash: string; date: number } | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${PUBLIC_REPO_SLUG}/commits/${PUBLIC_REPO_BRANCH}`,
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'littleCycling' } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { sha?: string; commit?: { committer?: { date?: string } } };
    const hash = body.sha;
    const iso = body.commit?.committer?.date;
    if (!hash || !iso) return null;
    return { hash, date: new Date(iso).getTime() };
  } catch {
    return null;
  }
}

/**
 * Compute the current update status. `existing` is the previously-persisted
 * status, used as a fallback for the remote fields when GitHub is unreachable.
 */
export async function checkForUpdate(cwd: string, existing: UpdateStatus): Promise<UpdateStatus> {
  const [local, remote] = await Promise.all([readLocalCommit(cwd), fetchRemoteCommit()]);

  const localHash = local?.hash ?? null;
  const localDate = local?.date ?? null;
  // Carry over the last-known remote if this fetch failed (persistent cache).
  const remoteHash = remote?.hash ?? existing.remoteHash;
  const remoteDate = remote?.date ?? existing.remoteDate;

  const updateAvailable =
    localHash != null &&
    remoteHash != null &&
    remoteHash !== localHash &&
    remoteDate != null &&
    localDate != null &&
    remoteDate > localDate;

  return {
    localHash,
    localDate,
    remoteHash,
    remoteDate,
    remoteUrl: `${PUBLIC_REPO_URL}/commits/${PUBLIC_REPO_BRANCH}`,
    updateAvailable,
    checkedAt: Date.now(),
  };
}
