import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, CheckCircle2, ChevronRight, CircleAlert, GitBranch,
  KeyRound, Link2, Network, RefreshCw, Search, ShieldCheck, Table2,
  Workflow, X
} from "lucide-react";
import { Link } from "react-router-dom";
import { getVersionRelationships, getApiError } from "../services/api";

const n = value => Number(value ?? 0);
const count = value => n(value).toLocaleString();
const percent = value => (n(value) * 100).toFixed(1) + "%";
const bandClass = value => String(value || "low").toLowerCase();
const humanize = value => String(value).replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());

function Metric({ title, value, note, tone = "" }) {
  return <div className="rel-metric"><span>{title}</span><strong className={tone}>{value}</strong>{note && <small>{note}</small>}</div>;
}

function formatEvidence(key, value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (key.toLowerCase().includes("percentage")) return value.toFixed(2) + "%";
    if (key.toLowerCase().includes("ratio") || key.toLowerCase().includes("overlap") || key.toLowerCase().includes("confidence")) {
      return value <= 1 ? (value * 100).toFixed(1) + "%" : value.toLocaleString();
    }
    return value.toLocaleString();
  }
  return String(value);
}

function GraphRelationship({ item, active, onSelect, onFocusTable }) {
  return <button type="button" className={"rel-graph-edge-card " + (active ? "active" : "")} onClick={onSelect} aria-pressed={active}>
    <span className="rel-graph-node parent">
      <span className="rel-graph-node-icon"><KeyRound size={15}/></span>
      <span className="rel-graph-node-copy"><small>PARENT TABLE</small><strong>{item.parentTable}</strong><code>{item.parentColumn}</code></span>
      <span className="rel-graph-key">PK</span>
    </span>
    <span className="rel-graph-connector">
      <span className={"rel-confidence " + bandClass(item.confidenceBand)}>{percent(item.confidence)} confidence</span>
      <span className="rel-graph-line"><i/><ArrowRight size={15}/></span>
      <small>ONE TO MANY · INFERRED</small>
    </span>
    <span className="rel-graph-node child">
      <span className="rel-graph-node-icon"><Link2 size={15}/></span>
      <span className="rel-graph-node-copy"><small>CHILD TABLE</small><strong>{item.childTable}</strong><code>{item.childColumn}</code></span>
      <span className="rel-graph-key fk">FK</span>
    </span>
    <span className="rel-graph-edge-stats">
      <span><CheckCircle2 size={13}/>{percent(item.valueOverlap)} overlap</span>
      <span className={n(item.orphanCount) ? "warn" : "good"}>{n(item.orphanCount) ? <CircleAlert size={13}/> : <ShieldCheck size={13}/>} {count(item.orphanCount)} orphans</span>
      <span className="rel-graph-open">{active ? "Selected" : "Inspect evidence"} <ChevronRight size={13}/></span>
    </span>
    <span className="sr-only" onClick={event => event.stopPropagation()}>
      <span onClick={() => onFocusTable(item.parentTable)}>{item.parentTable}</span>
      <span onClick={() => onFocusTable(item.childTable)}>{item.childTable}</span>
    </span>
  </button>;
}

function EvidencePanel({ item }) {
  if (!item) return <aside className="panel rel-evidence-panel rel-evidence-empty">
    <div className="rel-evidence-empty-icon"><Workflow size={23}/></div>
    <h3>Select a relationship</h3>
    <p>Choose a connection in Graph View or a linked field in Table View to inspect its evidence, confidence and referential integrity.</p>
  </aside>;

  const scalarEvidence = Object.entries(item.evidence || {}).filter(([, value]) =>
    value === null || ["string", "number", "boolean"].includes(typeof value)
  );
  const scoreTerms = item.evidence?.score_terms
    ? Object.entries(item.evidence.score_terms).filter(([, value]) => typeof value === "number")
    : [];
  const alternatives = Array.isArray(item.evidence?.other_candidate_parents)
    ? item.evidence.other_candidate_parents
    : [];

  return <aside className="panel rel-evidence-panel">
    <div className="rel-evidence-heading">
      <div><span className="eyebrow">RELATIONSHIP INSPECTOR</span><h2>Evidence details</h2></div>
      <span className="rel-inspector-status"><i/> Selected</span>
    </div>
    <div className="rel-inspector-route">
      <span className="rel-inspector-endpoint"><small>PARENT</small><strong>{item.parentTable}</strong><code>{item.parentColumn}</code></span>
      <span className="rel-inspector-arrow"><ArrowRight size={16}/></span>
      <span className="rel-inspector-endpoint child"><small>CHILD</small><strong>{item.childTable}</strong><code>{item.childColumn}</code></span>
    </div>
    <div className="rel-inspector-badges">
      <span className={"rel-confidence " + bandClass(item.confidenceBand)}>{humanize(item.confidenceBand || "candidate")} confidence</span>
      <span className="rel-inferred-badge">Inferred · 1 to many</span>
    </div>
    <div className="rel-inspector-metrics">
      <Metric title="CONFIDENCE" value={percent(item.confidence)} note="Inference score"/>
      <Metric title="VALUE OVERLAP" value={percent(item.valueOverlap)} note="Child values in parent"/>
      <Metric title="ORPHANS" value={count(item.orphanCount)} note="Unmatched child values" tone={n(item.orphanCount) ? "warning" : "success"}/>
      <Metric title="ORPHAN RATE" value={n(item.orphanPercentage).toFixed(2) + "%"} note="Of checked child values"/>
    </div>
    {Array.isArray(item.orphanExamples) && item.orphanExamples.length > 0 && <section className="rel-inspector-section rel-orphan-box">
      <h3><CircleAlert size={14}/> Sample orphan values</h3>
      <div>{item.orphanExamples.map((value, index) => <code key={index}>{String(value)}</code>)}</div>
    </section>}
    {scoreTerms.length > 0 && <section className="rel-inspector-section">
      <h3>Confidence score breakdown</h3>
      <div className="rel-score-breakdown">{scoreTerms.map(([key, value]) => <div key={key}>
        <span>{humanize(key)}</span><div><i style={{ width: Math.max(0, Math.min(100, n(value) * 100)) + "%" }}/></div><code>{percent(value)}</code>
      </div>)}</div>
    </section>}
    {scalarEvidence.length > 0 && <section className="rel-inspector-section">
      <h3>Technical evidence</h3>
      <div className="rel-evidence-grid">{scalarEvidence.map(([key, value]) => <div key={key}><span>{humanize(key)}</span><code>{formatEvidence(key, value)}</code></div>)}</div>
    </section>}
    {alternatives.length > 0 && <section className="rel-inspector-section">
      <h3>Alternative parent candidates</h3>
      <div className="rel-alternative-list">{alternatives.map((candidate, index) => <div key={index}>
        <span>{candidate.parent_table}.{candidate.parent_column}</span><strong>{percent(candidate.confidence)}</strong>
      </div>)}</div>
    </section>}
    <div className="rel-evidence-advisory"><ShieldCheck size={15}/><span>This is an inferred relationship, not an enforced database constraint. Validate it before using it as a verified key.</span></div>
  </aside>;
}

function TableView({ tables, items, focusedTable, selectedId, onFocusTable, onSelectRelationship }) {
  if (!tables.length) return <div className="rel-map-empty">Table metadata is unavailable for this version.</div>;

  return <div className="rel-table-view-grid">{tables.map(table => {
    const name = table.tableName;
    const links = items.filter(item => item.parentTable === name || item.childTable === name);
    const focused = focusedTable === name;
    return <article className={"rel-table-view-card " + (focused ? "focused" : "")} key={table.id || name}>
      <button type="button" className="rel-table-view-head" onClick={() => onFocusTable(focused ? "" : name)} aria-pressed={focused}>
        <span className="rel-table-view-icon"><Table2 size={16}/></span>
        <span className="rel-table-view-title"><strong>{name}</strong><small>{count(table.rowCount)} rows · {(table.columns || []).length} columns</small></span>
        <ChevronRight size={15}/>
      </button>
      <div className="rel-table-view-columns">{(table.columns || []).map(column => {
        const parentLinks = links.filter(item => item.parentTable === name && item.parentColumn === column.columnName);
        const childLinks = links.filter(item => item.childTable === name && item.childColumn === column.columnName);
        const isPk = column.isPkCandidate || parentLinks.length > 0;
        const isFk = childLinks.length > 0;
        return <div className="rel-table-view-column" key={column.id || column.columnName}>
          <span className="rel-column-symbol"><i/></span>
          <span className="rel-column-name"><strong>{column.columnName}</strong><small>{column.inferredType || "Unknown type"}</small></span>
          <span className="rel-column-tags">{isPk && <em>PK candidate</em>}{isFk && <em className="fk">FK candidate</em>}</span>
          {(parentLinks.length > 0 || childLinks.length > 0) && <div className="rel-column-links">
            {[...parentLinks, ...childLinks].map(item => <button type="button" key={item.id} className={String(item.id) === String(selectedId) ? "selected" : ""} onClick={() => onSelectRelationship(item.id)}>
              <Link2 size={11}/>{item.parentTable === name ? item.childTable : item.parentTable}<span>{percent(item.confidence)}</span>
            </button>)}
          </div>}
        </div>;
      })}</div>
      {links.length > 0 && <div className="rel-table-view-foot"><GitBranch size={12}/>{links.length} inferred connection{links.length === 1 ? "" : "s"}<button type="button" onClick={() => onSelectRelationship(links[0].id)}>Inspect first <ArrowRight size={11}/></button></div>}
    </article>;
  })}</div>;
}

export function RelationshipsPage({ projectId, versionId }) {
  const [items, setItems] = useState([]);
  const [tables, setTables] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [focusedTable, setFocusedTable] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("graph");

  const load = async () => {
    if (!projectId || !versionId) return;
    setLoading(true);
    setError("");
    try {
      const relationshipResponse = await getVersionRelationships(projectId, versionId);
      const next = relationshipResponse.data.relationships || [];
      setItems(next);
      setTables(relationshipResponse.data.tables || []);
      setSelected(current => next.some(item => String(item.id) === String(current)) ? current : String(next[0]?.id ?? ""));
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [projectId, versionId]);

  const summary = useMemo(() => ({
    relationships: items.length,
    tables: tables.length,
    orphans: items.reduce((sum, item) => sum + n(item.orphanCount), 0),
    confidence: items.length ? items.reduce((sum, item) => sum + n(item.confidence), 0) / items.length : 0,
    columns: tables.reduce((sum, table) => sum + (table.columns?.length || 0), 0),
  }), [items, tables]);

  const visible = useMemo(() => items.filter(item => {
    const haystack = [item.parentTable, item.parentColumn, item.childTable, item.childColumn].join(" ").toLowerCase();
    const matchesTable = !focusedTable || item.parentTable === focusedTable || item.childTable === focusedTable;
    return haystack.includes(search.toLowerCase()) && matchesTable &&
      (filter === "all" || (filter === "high" ? bandClass(item.confidenceBand) === "high" : n(item.orphanCount) > 0));
  }), [items, focusedTable, search, filter]);

  useEffect(() => {
    if (visible.length && !visible.some(item => String(item.id) === String(selected))) setSelected(String(visible[0].id));
    if (!visible.length && selected) setSelected("");
  }, [visible, selected]);

  const selectedItem = items.find(item => String(item.id) === String(selected)) || visible[0] || null;

  const selectRelationship = id => setSelected(String(id));
  const focusTable = name => setFocusedTable(name);

  if (!projectId) return <div className="page-stack"><div className="page-heading"><div><div className="eyebrow">SCHEMA INTELLIGENCE</div><h1>Relationship intelligence</h1><p>Explore how your uploaded tables connect and assess referential integrity.</p></div></div><div className="panel empty-state"><div className="empty-illustration"><Network size={27}/></div><h3>Connect your data</h3><p>Upload related CSV tables to discover candidate links between fields.</p><Link to="/upload" className="primary-button">Import related tables</Link></div></div>;

  return <div className="page-stack rel-page">
    <div className="page-heading"><div><div className="eyebrow">SCHEMA INTELLIGENCE / DATA MODEL</div><h1>Relationship intelligence</h1><p>Explore structural links, confidence and referential integrity for this dataset version.</p></div><button className="secondary-button" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""}/> Refresh analysis</button></div>

    <div className="rel-summary-grid">
      <Metric title="INFERRED RELATIONSHIPS" value={count(summary.relationships)} note="Candidate links detected"/>
      <Metric title="TABLES ANALYZED" value={count(summary.tables)} note={count(summary.columns) + " columns profiled"}/>
      <Metric title="AVERAGE CONFIDENCE" value={percent(summary.confidence)} note="Mean inference confidence"/>
      <Metric title="ORPHAN VALUES" value={count(summary.orphans)} note="Unmatched child values" tone={summary.orphans ? "warning" : "success"}/>
    </div>

    <div className="rel-explorer-toolbar">
      <div className="rel-view-switch" role="tablist" aria-label="Relationship view">
        <button type="button" role="tab" aria-selected={view === "graph"} className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}><Network size={14}/> Graph view</button>
        <button type="button" role="tab" aria-selected={view === "table"} className={view === "table" ? "active" : ""} onClick={() => setView("table")}><Table2 size={14}/> Table view</button>
      </div>
      <label className="rel-explorer-search"><Search size={14}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search tables or columns…"/>{search && <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><X size={13}/></button>}</label>
      <div className="rel-filter-switch" aria-label="Filter relationships">
        <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All <span>{items.length}</span></button>
        <button className={filter === "high" ? "active" : ""} onClick={() => setFilter("high")}>High confidence</button>
        <button className={filter === "orphans" ? "active" : ""} onClick={() => setFilter("orphans")}>Has orphans</button>
      </div>
      {focusedTable && <button type="button" className="rel-clear-focus" onClick={() => setFocusedTable("")}>Table: {focusedTable}<X size={12}/></button>}
    </div>

    {error && <div className="inline-alert">{error}</div>}
    <div className="rel-explorer-layout">
      <section className="panel rel-explorer-main">
        <div className="rel-section-heading">
          <div><span className="eyebrow">{view === "graph" ? "VISUAL SCHEMA" : "SCHEMA CATALOG"}</span><h2>{view === "graph" ? "Relationship graph" : "Tables and key candidates"}</h2><p>{view === "graph" ? "Select a connection to inspect its supporting evidence." : "Explore table columns and jump directly to their inferred connections."}</p></div>
          <span className="rel-count">{visible.length} relationship{visible.length === 1 ? "" : "s"}</span>
        </div>
        {loading && <div className="loading-state">Loading relationship model…</div>}
        {!loading && view === "graph" && <div className="rel-graph-canvas">
          <div className="rel-graph-legend"><span><i className="parent"/> Parent table</span><span><i className="child"/> Child table</span><span><i className="edge"/> Inferred link</span></div>
          {visible.length ? <div className="rel-graph-list">{visible.map(item => <GraphRelationship key={item.id} item={item} active={String(item.id) === String(selectedItem?.id)} onSelect={() => selectRelationship(item.id)} onFocusTable={focusTable}/>)}</div> : <div className="rel-map-empty">{items.length ? "No relationships match the current search or filters." : "No relationship candidates have been persisted for this version."}</div>}
        </div>}
        {!loading && view === "table" && <TableView tables={tables} items={visible} focusedTable={focusedTable} selectedId={selectedItem?.id} onFocusTable={focusTable} onSelectRelationship={selectRelationship}/>}
        <div className="rel-integrity-note"><ShieldCheck size={15}/> Inferred links are advisory. Validate them before treating them as enforced primary or foreign keys.</div>
      </section>
      <EvidencePanel item={selectedItem}/>
    </div>
  </div>;
}
