import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, CircleAlert, GitBranch, KeyRound, Link2, Network, RefreshCw, ShieldCheck, Table2 } from "lucide-react";
import { Link } from "react-router-dom";
import { getVersionRelationships, getApiError } from "../services/api";

const n = value => Number(value ?? 0);
const count = value => n(value).toLocaleString();
const percent = value => (n(value) * 100).toFixed(1) + "%";
const bandClass = value => String(value || "low").toLowerCase();
const humanize = value => value.replaceAll("_", " ").replace(/\b\w/g, c => c.toUpperCase());

function Metric({ title, value, note, tone = "" }) {
  return <div className="rel-metric"><span>{title}</span><strong className={tone}>{value}</strong>{note && <small>{note}</small>}</div>;
}

function RelationshipCard({ item, active, onClick }) {
  return <div className={"rel-record " + (active ? "active" : "")}>
    <button className="rel-record-summary" type="button" onClick={onClick} aria-expanded={active}>
      <div className="rel-record-route">
        <div className="rel-record-endpoint"><span className="rel-endpoint-icon parent"><KeyRound size={15}/></span><div><small>PARENT · PK CANDIDATE</small><strong>{item.parentTable}</strong><code>{item.parentColumn}</code></div></div>
        <div className="rel-record-link"><span className={"rel-confidence " + bandClass(item.confidenceBand)}>{item.confidenceBand || "Candidate"} · {(n(item.confidence) * 100).toFixed(1)}%</span><div><i/><ArrowRight size={16}/></div><small>INFERRED · 1 TO MANY</small></div>
        <div className="rel-record-endpoint"><span className="rel-endpoint-icon child"><Link2 size={15}/></span><div><small>CHILD · FK CANDIDATE</small><strong>{item.childTable}</strong><code>{item.childColumn}</code></div></div>
      </div>
      <div className="rel-record-stats"><span><ShieldCheck size={13}/>{percent(item.valueOverlap)} overlap</span><span className={n(item.orphanCount) ? "warn" : "good"}>{n(item.orphanCount) ? <CircleAlert size={13}/> : <CheckCircle2 size={13}/>} {count(item.orphanCount)} orphans</span><span>{n(item.orphanPercentage).toFixed(2)}% orphan rate</span><span className="rel-record-expand">{active ? "Hide evidence" : "View evidence"} <ChevronDown size={13}/></span></div>
    </button>
    {active && <div className="rel-record-details">
      <div className="rel-detail-grid">
        <Metric title="Confidence score" value={percent(item.confidence)} note={item.confidenceBand || "Candidate band"}/>
        <Metric title="Value overlap" value={percent(item.valueOverlap)} note="Child values present in parent"/>
        <Metric title="Orphan values" value={count(item.orphanCount)} note={n(item.orphanCount) ? "Unmatched child identifiers" : "No unmatched identifiers"} tone={n(item.orphanCount) ? "warning" : "success"}/>
        <Metric title="Orphan percentage" value={n(item.orphanPercentage).toFixed(2) + "%"} note="Of checked child values"/>
      </div>
      {Array.isArray(item.orphanExamples) && item.orphanExamples.length > 0 && <div className="rel-orphan-box"><strong><CircleAlert size={14}/> Sample orphan values</strong><div>{item.orphanExamples.map((value, index) => <code key={index}>{String(value)}</code>)}</div></div>}
      <div className="rel-technical"><strong>Technical evidence</strong><div className="rel-evidence-grid">{Object.entries(item.evidence || {}).filter(([,value]) => value === null || ["string","number","boolean"].includes(typeof value)).map(([key,value]) => <div key={key}><span>{humanize(key)}</span><code>{typeof value === "number" ? (key.includes("percentage") ? value.toFixed(2) + "%" : value.toLocaleString()) : String(value ?? "—")}</code></div>)}</div>
        {item.evidence?.score_terms && <div className="rel-score-breakdown"><strong>Confidence score components</strong>{Object.entries(item.evidence.score_terms).filter(([,value]) => typeof value === "number").map(([key,value]) => <div key={key}><span>{humanize(key)}</span><div><i style={{width: Math.max(0, Math.min(100, n(value) * 100)) + "%"}}/></div><code>{percent(value)}</code></div>)}</div>}
        {item.evidence?.other_candidate_parents?.length > 0 && <div className="rel-alternatives"><strong>Alternative parent candidates</strong>{item.evidence.other_candidate_parents.map((candidate,index)=><span key={index}>{candidate.parent_table}.{candidate.parent_column} · {percent(candidate.confidence)}</span>)}</div>}
      </div>
    </div>}
  </div>;
}

export function RelationshipsPage({ projectId, versionId }) {
  const [items, setItems] = useState([]);
  const [tables, setTables] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");

  const load = async () => {
    if (!projectId || !versionId) return;
    setLoading(true); setError("");
    try {
      const relationshipResponse = await getVersionRelationships(projectId, versionId);
      const next = relationshipResponse.data.relationships || [];
      setItems(next);
      setTables(relationshipResponse.data.tables || []);
      setSelected(current => next.some(item => item.id === current) ? current : next[0]?.id || "");
    } catch (err) { setError(getApiError(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [projectId, versionId]);

  const summary = useMemo(() => ({
    relationships: items.length,
    tables: tables.length,
    orphans: items.reduce((sum, item) => sum + n(item.orphanCount), 0),
    confidence: items.length ? items.reduce((sum, item) => sum + n(item.confidence), 0) / items.length : 0,
    columns: tables.reduce((sum, table) => sum + (table.columns?.length || 0), 0),
  }), [items, tables]);

  const visible = items.filter(item => {
    const haystack = [item.parentTable,item.parentColumn,item.childTable,item.childColumn].join(" ").toLowerCase();
    return haystack.includes(search.toLowerCase()) &&
      (filter === "all" || (filter === "high" ? bandClass(item.confidenceBand) === "high" : n(item.orphanCount) > 0));
  });

  if (!projectId) return <div className="page-stack"><div className="page-heading"><div><div className="eyebrow">SCHEMA INTELLIGENCE</div><h1>Relationship intelligence</h1><p>Explore how your uploaded tables connect and assess referential integrity.</p></div></div><div className="panel empty-state"><div className="empty-illustration"><Network size={27}/></div><h3>Connect your data</h3><p>Upload related CSV tables to discover candidate links between fields.</p><Link to="/upload" className="primary-button">Import related tables</Link></div></div>;

  return <div className="page-stack rel-page">
    <div className="page-heading"><div><div className="eyebrow">SCHEMA INTELLIGENCE / DATA MODEL</div><h1>Relationship intelligence</h1><p>Explore structural links, confidence and referential integrity for this dataset version.</p></div><button className="secondary-button" onClick={load} disabled={loading}><RefreshCw size={14} className={loading ? "spin" : ""}/> Refresh analysis</button></div>
    <div className="rel-summary-grid">
      <Metric title="INFERRED RELATIONSHIPS" value={count(summary.relationships)} note="Candidate links detected"/>
      <Metric title="TABLES ANALYZED" value={count(summary.tables)} note={count(summary.columns) + " columns profiled"}/>
      <Metric title="AVERAGE CONFIDENCE" value={percent(summary.confidence)} note="Mean inference confidence"/>
      <Metric title="ORPHAN VALUES" value={count(summary.orphans)} note="Unmatched child values" tone={summary.orphans ? "warning" : "success"}/>
    </div>
    <section className="panel rel-map-panel">
      <div className="rel-section-heading"><div><span className="eyebrow">SCHEMA OVERVIEW</span><h2>Relationship map</h2><p>Candidate parent-to-child links inferred from observed values and column characteristics.</p></div><div className="rel-map-legend"><span><i/> Parent</span><span><i/> Child</span></div></div>
      {loading && <div className="loading-state">Loading relationship model…</div>}
      {!loading && !error && items.length > 0 && <div className="rel-map-list">{items.map(item=><div className="rel-map-item" key={item.id}><div className="rel-map-table parent"><KeyRound size={14}/><div><strong>{item.parentTable}</strong><small>{item.parentColumn} · PK candidate</small></div></div><div className="rel-map-edge"><span>{(n(item.confidence)*100).toFixed(0)}%</span><div><i/><ArrowRight size={15}/></div><small>1 → N inferred</small></div><div className="rel-map-table child"><Link2 size={14}/><div><strong>{item.childTable}</strong><small>{item.childColumn} · FK candidate</small></div></div></div>)}</div>}
      {!loading && !error && items.length === 0 && <div className="rel-map-empty">No relationship candidates have been persisted for this version.</div>}
    </section>
    <section className="panel rel-schema-panel">
      <div className="rel-section-heading"><div><span className="eyebrow">TABLE CATALOG</span><h2>Tables and key candidates</h2><p>Primary-key labels below indicate profiler candidates, not declared database constraints.</p></div><span className="rel-count">{tables.length} tables</span></div>
      {tables.length ? <div className="rel-table-grid">{tables.map(table=><article className="rel-table-card" key={table.id || table.tableName}><header><Table2 size={15}/><strong>{table.tableName}</strong><span>{count(table.rowCount)} rows</span></header><div className="rel-table-columns">{(table.columns || []).map(column=>{
        const isParent = items.some(item => item.parentTable === table.tableName && item.parentColumn === column.columnName);
        const isChild = items.some(item => item.childTable === table.tableName && item.childColumn === column.columnName);
        return <div key={column.id || column.columnName}><span>{column.columnName}</span><small>{column.inferredType || "unknown"}</small>{(column.isPkCandidate || isParent) && <em>PK candidate</em>}{isChild && <em className="fk-candidate">FK candidate</em>}</div>;
      })}</div></article>)}</div> : <div className="rel-map-empty">Table metadata is unavailable for this version.</div>}
    </section>
    <section className="panel rel-results-panel">
      <div className="rel-section-heading"><div><span className="eyebrow">DETECTION RESULTS</span><h2>Candidate relationships</h2><p>Expand a result to inspect supporting evidence and orphan samples.</p></div><span className="rel-count">{visible.length} / {items.length}</span></div>
      <div className="rel-toolbar"><input value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search table or column…"/><div className="filter-tabs"><button className={filter==="all"?"selected":""} onClick={()=>setFilter("all")}>All</button><button className={filter==="high"?"selected":""} onClick={()=>setFilter("high")}>High confidence</button><button className={filter==="orphans"?"selected":""} onClick={()=>setFilter("orphans")}>Has orphans</button></div></div>
      {error && <div className="inline-alert">{error}</div>}
      {!loading && !error && visible.length===0 && <div className="rel-map-empty">No relationship results match this filter.</div>}
      <div className="rel-result-list">{visible.map(item=><RelationshipCard key={item.id} item={item} active={selected===item.id} onClick={()=>setSelected(selected===item.id?"":item.id)}/>)}</div>
      <div className="rel-integrity-note"><ShieldCheck size={15}/> Inferred links are advisory. Confirm constraints in the source database before treating them as enforced primary or foreign keys.</div>
    </section>
  </div>;
}
