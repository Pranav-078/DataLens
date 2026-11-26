import {useEffect,useState} from "react";
import {Navigate,NavLink,Route,Routes,useNavigate} from "react-router-dom";
import {Activity,ArrowUpRight,Bell,BookOpen,ChevronDown,Database,FileUp,GitBranch,LayoutDashboard,LogOut,Search,Sparkles,TriangleAlert} from "lucide-react";
import {Dashboard} from "./pages/Dashboard";
import {UploadPage} from "./pages/UploadPage";
import {DatasetsPage} from "./pages/DatasetsPage";
import {IssuesPage} from "./pages/IssuesPage";
import {RelationshipsPage} from "./pages/RelationshipsPage";
import {LoginPage} from "./pages/LoginPage";
import {AiWorkspace} from "./pages/AiWorkspace";
import {checkApiReadiness,getProjectSummary,getAuthSession,loginUser,logoutUser} from "./services/api";
function Shell({children,onLogout,apiStatus}){
 const links=[["/","Overview",LayoutDashboard],["/datasets","Data catalog",Database],["/upload","Upload CSVs",FileUp],["/issues","Quality issues",TriangleAlert],["/relationships","Relationships",GitBranch]];
 return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><Activity size={19}/></div><span>data<span className="brand-accent">lens</span></span><small>BETA</small></div><div className="workspace-switch"><b>D</b><span><strong>DataLens workspace</strong><small>Personal workspace</small></span><ChevronDown size={14}/></div><div className="nav-label">WORKSPACE</div>{links.map(([to,label,Icon])=><NavLink end={to==="/"} to={to} key={to} className={({isActive})=>"nav-link"+(isActive?" active":"")}><Icon size={17}/>{label}</NavLink>)}<div className="nav-label nav-gap">INTELLIGENCE</div><NavLink to="/ai" className={({isActive})=>"nav-link"+(isActive?" active":"")}><Sparkles size={17}/>AI workspace</NavLink><div className="sidebar-bottom"><div className="help-card"><BookOpen size={16}/><strong>New to DataLens?</strong><p>Explore how data quality monitoring works.</p><a href="https://github.com/Pranav-078/DataLens" target="_blank" rel="noreferrer">View documentation <ArrowUpRight size={13}/></a></div><button className="profile-row" onClick={onLogout}><b>DL</b><span><strong>Workspace user</strong><small>Workspace session</small></span><LogOut size={15}/></button></div></aside><main className="main-area"><header className="topbar"><div className="crumb">Workspace <i>/</i> <strong>{({"/":"Overview","/datasets":"Data catalog","/upload":"Upload CSVs","/issues":"Quality issues","/relationships":"Relationships","/ai":"AI workspace"})[location.pathname]||"Workspace"}</strong></div><div className="top-actions"><span className={"api-status "+apiStatus}><i/> {apiStatus==="ready"?"API connected":apiStatus==="checking"?"Checking API…":"API unavailable"}</span><button className="icon-button"><Search size={17}/></button><button className="icon-button"><Bell size={17}/></button><b className="top-avatar">DL</b></div></header><div className="page-content">{children}</div></main></div>;
}
export default function App(){
 const [auth,setAuth]=useState(false);
 const [authEnabled,setAuthEnabled]=useState(false);
 const [authChecking,setAuthChecking]=useState(true);
 const [authCheckError,setAuthCheckError]=useState("");
 const [apiStatus,setApiStatus]=useState("checking");
 const [projectId,setProjectId]=useState(()=>localStorage.getItem("datalens-project-id")||"");
 const [versionId,setVersionId]=useState(()=>localStorage.getItem("datalens-version-id")||"");
 const [projectName,setProjectName]=useState(()=>localStorage.getItem("datalens-project-name")||"Your workspace");
 const navigate=useNavigate();
 useEffect(()=>{
  let active=true;
  getAuthSession().then(response=>{
   if(!active)return;
   setAuthEnabled(Boolean(response.data.authEnabled));
   setAuth(Boolean(response.data.authenticated));
  }).catch(()=>{
   if(!active)return;
   setAuthEnabled(true);
   setAuth(false);
   setAuthCheckError("Unable to reach the API. Check that the DataLens backend is running.");
  }).finally(()=>{if(active)setAuthChecking(false)});
  return()=>{active=false};
 },[]);
 useEffect(()=>{if(!auth)return;let active=true;checkApiReadiness().then(()=>{if(active)setApiStatus("ready")}).catch(()=>{if(active)setApiStatus("offline")});return()=>{active=false}},[auth]);
 const logout=async()=>{try{if(authEnabled)await logoutUser()}catch{}finally{setAuth(false);navigate("/login")}};
 const handleLogin=async credentials=>{await loginUser(credentials);setAuth(true);setAuthCheckError("");navigate("/")};
 const continuePreview=()=>{setAuth(true);navigate("/")};
 const complete=async result=>{setProjectId(result.projectId);setVersionId(result.versionId);localStorage.setItem("datalens-project-id",result.projectId);localStorage.setItem("datalens-version-id",result.versionId);try{const response=await getProjectSummary(result.projectId);const name=response.data.name||"DataLens project";setProjectName(name);localStorage.setItem("datalens-project-name",name)}catch{setProjectName("DataLens project")}navigate("/datasets")};
 if(authChecking)return <div className="auth-loading">Checking DataLens access…</div>;
 if(!auth)return <Routes><Route path="/login" element={<LoginPage authEnabled={authEnabled} onLogin={handleLogin} onContinue={continuePreview} initialNotice={authCheckError}/>}/><Route path="*" element={<Navigate to="/login" replace/>}/></Routes>;
 return <Shell onLogout={logout} apiStatus={apiStatus}><Routes><Route path="/" element={<Dashboard projectId={projectId} versionId={versionId}/>}/><Route path="/upload" element={<UploadPage projectId={projectId} onComplete={complete}/>}/><Route path="/datasets" element={<DatasetsPage projectId={projectId} versionId={versionId} projectName={projectName}/>}/><Route path="/issues" element={<IssuesPage projectId={projectId} versionId={versionId}/>}/><Route path="/relationships" element={<RelationshipsPage projectId={projectId} versionId={versionId}/>}/><Route path="/ai" element={<AiWorkspace projectId={projectId} versionId={versionId}/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Routes></Shell>;
}