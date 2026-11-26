import {useRef,useState} from "react";
import {Bot,FileText,Paperclip,Send, Sparkles,LoaderCircle,BookOpen,Database} from "lucide-react";
import {sendAiMessage,uploadKnowledgeDocument,getApiError} from "../services/api";

export function AiWorkspace({projectId,versionId}){
 const [messages,setMessages]=useState([{role:"assistant",content:"Hi! I'm the DataLens AI assistant. I can explain quality issues, explore your schema and relationships, and answer questions using your uploaded knowledge documents."}]);
 const [question,setQuestion]=useState("");
 const [sessionId,setSessionId]=useState("");
 const [busy,setBusy]=useState(false);
 const [uploading,setUploading]=useState(false);
 const [notice,setNotice]=useState("");
 const fileRef=useRef(null);
 const send=async()=>{
  const text=question.trim(); if(!text||busy)return;
  setQuestion("");setMessages(items=>[...items,{role:"user",content:text}]);setBusy(true);setNotice("");
  try{
   const response=await sendAiMessage(projectId,{question:text,versionId:versionId||undefined,sessionId:sessionId||undefined});
   setSessionId(response.data.sessionId);
   setMessages(items=>[...items,{role:"assistant",content:response.data.answer,sources:response.data.sources||[],toolUsed:response.data.toolUsed}]);
  }catch(error){setMessages(items=>[...items,{role:"assistant",content:getApiError(error)}]);}
  finally{setBusy(false);}
 };
 const upload=async event=>{
  const file=event.target.files?.[0];event.target.value="";if(!file)return;
  setUploading(true);setNotice("");
  try{const result=await uploadKnowledgeDocument(projectId,file);setNotice(`Indexed ${result.data.filename} into ${result.data.chunkCount} searchable passages.`);}
  catch(error){setNotice(getApiError(error));}
  finally{setUploading(false);}
 };
 return <div className="page-stack ai-page">
  <div className="page-heading"><div><div className="eyebrow">GEMINI-POWERED INTELLIGENCE</div><h1>AI workspace</h1><p>Ask questions about your data and search your project knowledge.</p></div><div className="ai-model-pill"><Sparkles size={15}/> Gemini AI</div></div>
  {!projectId&&<div className="demo-banner"><Database size={16}/> Upload a CSV dataset first to enable project chat and dataset analysis.</div>}
  <div className="ai-layout">
   <aside className="ai-knowledge panel"><div className="knowledge-heading"><BookOpen size={18}/><h3>Knowledge base</h3></div><p>Upload project documentation, data dictionaries, specifications, and PDF notes. DataLens indexes the content for retrieval.</p>
    <input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" hidden onChange={upload}/>
    <button className="secondary-button knowledge-upload" disabled={!projectId||uploading} onClick={()=>fileRef.current?.click()}>{uploading?<LoaderCircle className="spin" size={16}/>:<Paperclip size={16}/>} {uploading?"Indexing…":"Add document"}</button>
    <div className="knowledge-hint"><FileText size={15}/> PDF, TXT, or Markdown · max 10 MB</div>
    {notice&&<div className="ai-notice">{notice}</div>}
    <div className="knowledge-note"><strong>How it works</strong><span>Gemini extracts and embeds document content. Relevant passages are retrieved when you ask a question.</span></div>
   </aside>
   <section className="ai-chat panel">
    <div className="chat-header"><div className="chat-avatar"><Bot size={19}/></div><div><strong>DataLens assistant</strong><span>Grounded answers · Read-only analysis</span></div><span className="online-dot">● Online</span></div>
    <div className="chat-messages">{messages.map((message,index)=><div className={"chat-message "+message.role} key={index}><div className="message-avatar">{message.role==="assistant"?<Bot size={16}/>: "You"}</div><div className="message-body"><div className="message-content">{message.content}</div>{message.toolUsed&&message.toolUsed!=="none"&&<div className="tool-used"><Sparkles size={12}/> Data tool: {message.toolUsed.replaceAll("_"," ")}</div>}{message.sources?.length>0&&<div className="source-list"><strong>Sources</strong>{message.sources.map(source=><span key={source.citation}><FileText size={12}/> [{source.citation}] {source.filename} · passage {source.chunkIndex+1}</span>)}</div>}</div></div>)}{busy&&<div className="chat-message assistant"><div className="message-avatar"><Bot size={16}/></div><div className="typing-indicator"><i/><i/><i/> Thinking…</div></div>}</div>
    <form className="chat-composer" onSubmit={event=>{event.preventDefault();send();}}><textarea value={question} onChange={event=>setQuestion(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();send();}}} placeholder={projectId?"Ask about quality issues, schema, relationships, or your documents…":"Upload a dataset to start asking questions…"} disabled={!projectId||busy} rows={2}/><button className="primary-button send-button" type="submit" disabled={!projectId||busy||!question.trim()}><Send size={16}/></button></form>
    <div className="chat-disclaimer">AI responses can be inaccurate. Verify important findings against the displayed dataset evidence.</div>
   </section>
  </div>
 </div>;
}
