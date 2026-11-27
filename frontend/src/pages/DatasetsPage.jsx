import { useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight, CalendarClock, CheckCircle2, ChevronRight, Database,
  FileSpreadsheet, Layers3, RefreshCw, Table2
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  getProjectVersions, getVersionTables, getApiError
} from "../services/api";

const formatDate = value => {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

const versionStatus = status => String(status || "unknown").toLowerCase();

export function DatasetsPage({ projectId, versionId, projectName, onVersionChange }) {
  const [tables, setTables] = useState([]);
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState("");

  const selectedVersion = useMemo(
    () => versions.find(version => version.id === versionId) || null,
    [versions, versionId]
  );

  const loadVersions = async () => {
    if (!projectId) return;
    setHistoryLoading(true);
    setError("");
    try {
      const response = await getProjectVersions(projectId);
      const nextVersions = response.data.versions || [];
      setVersions(nextVersions);

      // Keep a valid explicit selection. Otherwise choose the newest ready
      // upload (the API returns versions newest-first).
      const currentExists = nextVersions.some(version => version.id === versionId);
      const latestReady = nextVersions.find(version => version.status === "ready") || nextVersions[0];
      if ((!currentExists || !versionId) && latestReady?.id) {
        onVersionChange?.(latestReady.id);
      }
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (!projectId) return undefined;
    setHistoryLoading(true);
    getProjectVersions(projectId).then(response => {
      if (!active) return;
      const nextVersions = response.data.versions || [];
      setVersions(nextVersions);
      const latestReady = nextVersions.find(version => version.status === "ready") || nextVersions[0];
      const currentExists = nextVersions.some(version => version.id === versionId);
      if ((!currentExists || !versionId) && latestReady?.id) onVersionChange?.(latestReady.id);
    }).catch(err => {
      if (active) setError(getApiError(err));
    }).finally(() => {
      if (active) setHistoryLoading(false);
    });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    let active = true;
    if (!projectId || !versionId) {
      setTables([]);
      return undefined;
    }
    setLoading(true);
    setError("");
    getVersionTables(projectId, versionId).then(response => {
      if (active) setTables(response.data.tables || []);
    }).catch(err => {
      if (active) {
        setTables([]);
        setError(getApiError(err));
      }
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [projectId, versionId]);

  const handleVersionChange = event => {
    const nextId = event.target.value;
    if (nextId) onVersionChange?.(nextId);
  };

  if (!projectId) return <div className="page-stack">
    <div className="page-heading"><div><div className="eyebrow">DATA CATALOG</div><h1>Data catalog</h1><p>Browse the tables and schemas already processed by DataLens.</p></div></div>
    <div className="panel empty-state"><div className="empty-illustration"><Database size={27}/></div><h3>No datasets yet</h3><p>Upload related CSV files to create your first project and inspect table structure.</p><Link to="/upload" className="primary-button">Create first dataset <ArrowUpRight size={15}/></Link></div>
  </div>;

  return <div className="page-stack">
    <div className="page-heading">
      <div><div className="eyebrow">DATA CATALOG</div><h1>Data catalog</h1><p>Browse dataset versions, tables and schemas. New uploads become the latest version automatically.</p></div>
      <Link to="/upload" className="primary-button"><FileSpreadsheet size={16}/> Upload new version</Link>
    </div>

    <div className="catalog-summary">
      <div><span>PROJECT</span><strong>{projectName}</strong></div>
      <div><span>SELECTED VERSION</span><strong>{selectedVersion ? "Version " + selectedVersion.versionNumber : versionId ? versionId.slice(0, 12) + "…" : "No version selected"}</strong><small>{selectedVersion ? formatDate(selectedVersion.createdAt) : ""}</small></div>
      <div><span>TABLES FOUND</span><strong>{tables.length}</strong><small>{versions.length} saved version{versions.length === 1 ? "" : "s"}</small></div>
    </div>

    {error && <div className="inline-alert">{error}</div>}

    <section className="panel version-history-panel">
      <div className="version-history-copy">
        <span className="version-history-icon"><CalendarClock size={17}/></span>
        <div><h3>Version history</h3><p>Every successful upload is preserved. Choose a version to inspect its tables and quality results.</p></div>
      </div>
      <div className="version-history-select-wrap">
        <label htmlFor="dataset-version-select">Viewing version</label>
        <select id="dataset-version-select" value={versionId || ""} onChange={handleVersionChange} disabled={historyLoading || versions.length === 0}>
          {versions.length === 0 && <option value="">No versions available</option>}
          {versions.map(version => <option key={version.id} value={version.id}>Version {version.versionNumber} · {version.status}{version.label ? " · " + version.label : ""} · {formatDate(version.createdAt)}</option>)}
        </select>
        <button className="icon-button" type="button" onClick={loadVersions} disabled={historyLoading} aria-label="Refresh version history"><RefreshCw size={15} className={historyLoading ? "spin" : ""}/></button>
      </div>
      {selectedVersion && <div className="version-history-status">
        <span className={"version-state " + versionStatus(selectedVersion.status)}><i/>{selectedVersion.status}</span>
        {selectedVersion.status === "ready" && <span className="version-ready-note"><CheckCircle2 size={13}/> Profiling completed</span>}
        {selectedVersion.status === "failed" && <span className="version-failed-note">This upload failed. Previous successful versions are still available.</span>}
        {String(selectedVersion.label || "").startsWith("FAST PREVIEW") && <span className="version-preview-note">Sample-based estimates · not a full-data audit</span>}
      </div>}
    </section>

    <div className="panel table-panel">
      <div className="panel-heading">
        <div><h3>Tables in this version</h3><p>{selectedVersion ? "Version " + selectedVersion.versionNumber + " · " + formatDate(selectedVersion.createdAt) : "Column-level metadata and profiling statistics"}</p></div>
        <button className="icon-button" type="button" onClick={() => {
          if (!projectId || !versionId) return;
          setLoading(true);
          getVersionTables(projectId, versionId).then(response => setTables(response.data.tables || [])).catch(err => setError(getApiError(err))).finally(() => setLoading(false));
        }} disabled={loading || !versionId} aria-label="Refresh tables"><RefreshCw size={16} className={loading ? "spin" : ""}/></button>
      </div>
      {loading ? <div className="loading-state">Loading tables for selected version…</div> : tables.length ? <div className="data-table-wrap">
        <table className="data-table"><thead><tr><th>TABLE NAME</th><th>ROWS</th><th>COLUMNS</th><th>PROFILED FIELDS</th><th></th></tr></thead>
          <tbody>{tables.map(table => <tr key={table.id}>
            <td><div className="table-name-cell"><div className="table-small-icon"><Table2 size={16}/></div><div><strong>{table.tableName}</strong><span>{table.originalFilename}</span></div></div></td>
            <td>{Number(table.rowCount || 0).toLocaleString()}</td><td>{table.columnCount}</td><td><span className="profiled-pill">{table.columns?.length || 0} fields</span></td><td><ChevronRight size={16} className="muted-icon"/></td>
          </tr>)}</tbody>
        </table>
      </div> : <div className="empty-mini">{selectedVersion?.status === "failed" ? "This version did not complete profiling. Select an earlier ready version to browse its data." : "No table metadata was returned for this version."}</div>}
    </div>

    {tables.length > 0 && <div className="panel schema-panel">
      <div className="panel-heading"><div><h3>Schema preview</h3><p>Inferred field types from the selected version</p></div><Layers3 size={18} className="muted-icon"/></div>
      <div className="schema-grid">{tables.slice(0, 4).map(table => <div className="schema-card" key={table.id}>
        <div className="schema-card-title"><Table2 size={15}/><strong>{table.tableName}</strong></div>
        {(table.columns || []).slice(0, 5).map(column => <div className="schema-field" key={column.id}><span>{column.columnName}</span><code>{column.inferredType || "unknown"}</code></div>)}
        {table.columns?.length > 5 && <div className="schema-more">+{table.columns.length - 5} more columns</div>}
      </div>)}</div>
    </div>}
  </div>;
}
