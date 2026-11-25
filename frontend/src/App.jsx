import {useState} from "react";
import {Navigate,NavLink,Route,Routes,useNavigate} from "react-router-dom";
import {Activity,ArrowUpRight,Bell,BookOpen,Bot,ChevronDown,Database,FileUp,GitBranch,LayoutDashboard,LogOut,Search,Sparkles,TriangleAlert} from "lucide-react";
import {Dashboard} from "./pages/Dashboard";
import {UploadPage} from "./pages/UploadPage";
import {DatasetsPage} from "./pages/DatasetsPage";
import {IssuesPage} from "./pages/IssuesPage";
import {RelationshipsPage} from "./pages/RelationshipsPage";
import {LoginPage} from "./pages/LoginPage";
function Shell({children,onLogout}){
 const links=[["/","Overview",LayoutDashboard],["/datasets","Data catalog",Database],["/upload","Upload CSVs",FileUp],["/issues","Quality issues",TriangleAlert],["/relationships","Relationships",GitBranch]];
 return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><Activity size={19}/></div><span>data<span className="brand-accent">lens</span></span><small>BETA</small></div><div className="workspace-switch"><b>D</b><span><strong>DataLens workspace</strong><small>Personal workspace</small></span><ChevronDown size={14}/></div><div className="nav-label">WORKSPACE</div>{links.map(([to,label,Icon])=><NavLink end={to==="/"} to={to} key={to} className={({isActive})=>"nav-link"+(isActive?" active":"")}><Icon size={17}/>{label}</NavLink>)}<div className="nav-label nav-gap">INTELLIGENCE</div><div className="nav-link disabled"><Sparkles size={17}/>AI workspace <small>SOON</small></div><div className="nav-link disabled"><Bot size={17}/>Agent workflows <small>SOON</small></div><div className="sidebar-bottom"><div className="help-card"><BookOpen size={16}/><strong>New to DataLens?</strong><p>Explore how data quality monitoring works.</p><a href="https://github.com/Pranav-078/DataLens" target="_blank" rel="noreferrer">View documentation <ArrowUpRight size={13}/></a></div><button className="profile-row" onClick={onLogout}><b>DL</b><span><strong>Workspace user</strong><small>Preview account</small></span><LogOut size={15}/></button></div></aside><main className="main-area"><header className="topbar"><div className="crumb">Workspace <i>/</i> <strong>{({"/":"Overview","/datasets":"Data catalog","/upload":"Upload CSVs","/issues":"Quality issues","/relationships":"Relationships"})[location.pathname]||"Workspace"}</strong></div><div className="top-actions"><span className="api-status"><i/> API connection configurable</span><button className="icon-button"><Search size={17}/></button><button className="icon-button"><Bell size={17}/></button><b className="top-avatar">DL</b></div></header><div className="page-content">{children}</div></main></div>;
}
export default function App(){
 const [auth,setAuth]=useState(()=>sessionStorage.getItem("datalens-preview")==="yes");
 const [projectId,setProjectId]=useState(()=>localStorage.getItem("datalens-project-id")||"");
 const [versionId,setVersionId]=useState(()=>localStorage.getItem("datalens-version-id")||"");
 const [projectName,setProjectName]=useState(()=>localStorage.getItem("datalens-project-name")||"Your workspace");
 const navigate=useNavigate();
 const logout=()=>{sessionStorage.removeItem("datalens-preview");setAuth(false);navigate("/login")};
 const complete=result=>{setProjectId(result.projectId);setVersionId(result.versionId);setProjectName("DataLens project");localStorage.setItem("datalens-project-id",result.projectId);localStorage.setItem("datalens-version-id",result.versionId);localStorage.setItem("datalens-project-name","DataLens project");navigate("/datasets")};
 if(!auth)return <Routes><Route path="/login" element={<LoginPage onContinue={()=>{sessionStorage.setItem("datalens-preview","yes");setAuth(true);navigate("/")}}/>}/><Route path="*" element={<Navigate to="/login" replace/>}/></Routes>;
 return <Shell onLogout={logout}><Routes><Route path="/" element={<Dashboard projectId={projectId} versionId={versionId}/>}/><Route path="/upload" element={<UploadPage projectId={projectId} onComplete={complete}/>}/><Route path="/datasets" element={<DatasetsPage projectId={projectId} versionId={versionId} projectName={projectName}/>}/><Route path="/issues" element={<IssuesPage projectId={projectId} versionId={versionId}/>}/><Route path="/relationships" element={<RelationshipsPage projectId={projectId} versionId={versionId}/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Routes></Shell>;
}