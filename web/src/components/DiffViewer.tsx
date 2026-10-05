import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../api';
import { fmtInt, parsePatch } from '../format';
import type { DiffFile, LaneDiff } from '../types';
import { ErrorNote, Spinner } from './ui';

const MAX_ROWS = 2000;

const STATUS_MARK: Record<DiffFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

function FilePatch({ file }: { file: DiffFile }) {
  const rows = useMemo(() => parsePatch(file.patch ?? ''), [file.patch]);
  const [all, setAll] = useState(false);
  useEffect(() => setAll(false), [file.path]);
  const shown = all ? rows : rows.slice(0, MAX_ROWS);

  if (file.binary) return <p className="diff-notice">Binary file. Its contents are not shown.</p>;
  if (rows.length === 0) {
    return (
      <p className="diff-notice">
        {file.truncated ? 'This file is too large to show here.' : 'No text changes to show for this file.'}
      </p>
    );
  }
  return (
    <>
      {file.truncated && <p className="diff-notice">This diff was cut short because the file is very large.</p>}
      <table className="diff-table">
        <tbody>
          {shown.map((r, i) =>
            r.type === 'hunk' ? (
              <tr key={i} className="d-hunk">
                <td colSpan={3}>{r.text}</td>
              </tr>
            ) : (
              <tr key={i} className={`d-${r.type}`}>
                <td className="ln">{r.oldNo ?? ''}</td>
                <td className="ln">{r.newNo ?? ''}</td>
                <td className="code">
                  <span className="sign">{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
                  {r.text}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {!all && rows.length > MAX_ROWS && (
        <p className="diff-notice">
          Showing the first {fmtInt(MAX_ROWS)} of {fmtInt(rows.length)} lines.{' '}
          <button type="button" className="link" onClick={() => setAll(true)}>
            Show all
          </button>
        </p>
      )}
    </>
  );
}

export function DiffViewer({ raceId, laneId, ended }: { raceId: string; laneId: string; ended: boolean }) {
  const [diff, setDiff] = useState<LaneDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setDiff(null);
    api
      .diff(raceId, laneId)
      .then((d) => {
        if (!alive) return;
        const files = Array.isArray(d?.files) ? d.files : [];
        setDiff({ files, truncated: !!d?.truncated });
        setSelected((cur) => (cur && files.some((f) => f.path === cur) ? cur : (files[0]?.path ?? null)));
      })
      .catch((err) => {
        if (alive) setError(errorText(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [raceId, laneId, ended, nonce]);

  if (loading) {
    return (
      <p className="loading">
        <Spinner /> Loading the diff…
      </p>
    );
  }
  if (error) {
    return (
      <div>
        <ErrorNote>{error}</ErrorNote>
        <button type="button" className="btn small" onClick={() => setNonce((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!diff || diff.files.length === 0) {
    return (
      <p className="muted">
        {ended ? 'This agent changed no files.' : 'No changes yet.'}{' '}
        <button type="button" className="link" onClick={() => setNonce((n) => n + 1)}>
          Refresh
        </button>
      </p>
    );
  }
  const file = diff.files.find((f) => f.path === selected) ?? diff.files[0]!;

  return (
    <div className="diff">
      <nav className="diff-files" aria-label="Changed files">
        {!ended && (
          <button type="button" className="link" onClick={() => setNonce((n) => n + 1)}>
            Refresh (lane still running)
          </button>
        )}
        {diff.files.map((f) => (
          <button
            key={f.path}
            type="button"
            className={`diff-file${f.path === file.path ? ' active' : ''}`}
            onClick={() => setSelected(f.path)}
            title={`${f.path} (${f.status})`}
          >
            <span className={`fs fs-${f.status}`}>{STATUS_MARK[f.status] ?? '?'}</span>
            <span className="path">{f.path}</span>
            {f.binary ? (
              <span className="muted">bin</span>
            ) : (
              <span className="pm">
                <span className="plus">+{f.added ?? 0}</span> <span className="minus">-{f.removed ?? 0}</span>
              </span>
            )}
          </button>
        ))}
        {diff.truncated && <p className="diff-notice">Some files are left out because the diff is very large.</p>}
      </nav>
      <div className="diff-patch">
        <div className="diff-patch-head">
          <code>{file.path}</code>
          <span className="muted">{file.status}</span>
        </div>
        <div className="diff-scroll">
          <FilePatch file={file} />
        </div>
      </div>
    </div>
  );
}
