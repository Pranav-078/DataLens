import { useEffect, useRef, useState } from "react";
import { Bot, FileText, Paperclip, Send, Sparkles, LoaderCircle, BookOpen, Database, Mic, MicOff, Plus, MessageSquare } from "lucide-react";
import { streamAiMessage, uploadKnowledgeDocument, listAiSessions, getAiSession, getApiError } from "../services/api";

const welcome = { role: "assistant", content: "Hi! I'm the DataLens AI assistant. I can explain quality issues, explore your schema and relationships, and answer questions using your uploaded knowledge documents." };

export function AiWorkspace({ projectId, versionId }) {
  const [messages, setMessages] = useState([welcome]);
  const [question, setQuestion] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const fileRef = useRef(null);
  const recognitionRef = useRef(null);
  const messageListRef = useRef(null);

  const refreshSessions = async () => {
    if (!projectId) return;
    try {
      const response = await listAiSessions(projectId);
      setSessions(response.data.sessions || []);
    } catch (error) { setNotice(getApiError(error)); }
  };

  useEffect(() => { refreshSessions(); }, [projectId]);
  useEffect(() => {
    if (messageListRef.current) messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [messages, busy]);
  useEffect(() => () => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      try { recognitionRef.current.stop(); } catch {}
    }
  }, []);

  const stopVoice = () => {
    try { recognitionRef.current?.stop(); } catch {}
    recognitionRef.current = null;
    setListening(false);
  };

  const startVoice = () => {
    setVoiceError("");
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceError("Speech recognition is unavailable in this browser. You can still type your question.");
      return;
    }
    try {
      const recognition = new SpeechRecognition();
      recognition.lang = navigator.language || "en-IN";
      recognition.continuous = true;
      recognition.interimResults = true;
      let finalTranscript = "";
      recognition.onresult = event => {
        let interim = "";
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const transcript = event.results[index][0]?.transcript || "";
          if (event.results[index].isFinal) finalTranscript += transcript + " ";
          else interim += transcript;
        }
        setQuestion(finalTranscript + interim);
      };
      recognition.onerror = event => {
        const knownErrors = {
          "not-allowed": "Microphone permission was denied. Enable access in your browser settings.",
          "no-speech": "No speech was detected. Try speaking again.",
          "audio-capture": "No microphone was detected by the browser.",
        };
        setVoiceError(knownErrors[event.error] || "Voice input failed. Please type your question instead.");
        setListening(false);
      };
      recognition.onend = () => {
        setListening(false);
        if (recognitionRef.current === recognition) recognitionRef.current = null;
      };
      recognitionRef.current = recognition;
      recognition.start();
      setListening(true);
    } catch {
      setVoiceError("Could not start microphone input. Check browser permission and try again.");
      setListening(false);
    }
  };

  const send = async event => {
    event?.preventDefault();
    const text = question.trim();
    if (!text || busy || !projectId) return;

    stopVoice();
    setQuestion("");
    setBusy(true);
    setNotice("");
    setVoiceError("");

    const streamId = "stream-" + Date.now();
    setMessages(current => [
      ...current,
      { role: "user", content: text },
      { id: streamId, role: "assistant", content: "", streaming: true },
    ]);

    try {
      await streamAiMessage(projectId, {
        question: text,
        versionId: versionId || undefined,
        sessionId: sessionId || undefined,
      }, event => {
        if (event.type === "meta") {
          setSessionId(event.sessionId);
          setMessages(current => current.map(message => message.id === streamId
            ? { ...message, toolUsed: event.toolUsed, sources: event.sources || [] }
            : message));
        } else if (event.type === "delta") {
          setMessages(current => current.map(message => message.id === streamId
            ? { ...message, content: message.content + (event.text || "") }
            : message));
        } else if (event.type === "done") {
          setMessages(current => current.map(message => message.id === streamId
            ? { ...message, id: event.messageId || streamId, streaming: false }
            : message));
        }
      });
      setMessages(current => current.map(message => message.id === streamId
        ? { ...message, streaming: false }
        : message));
      refreshSessions();
    } catch (error) {
      setMessages(current => current.map(message => message.id === streamId
        ? {
            ...message,
            content: message.content || getApiError(error),
            streaming: false,
            failed: true,
          }
        : message));
    } finally {
      setBusy(false);
    }
  };

  const newChat = () => {
    stopVoice(); setSessionId(""); setMessages([welcome]); setQuestion(""); setVoiceError("");
  };

  const openSession = async id => {
    if (!id || busy) return;
    stopVoice(); setNotice("");
    try {
      const response = await getAiSession(projectId, id);
      setSessionId(id);
      setMessages(response.data.messages?.length ? response.data.messages : [welcome]);
    } catch (error) { setNotice(getApiError(error)); }
  };

  const upload = async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true); setNotice("");
    try {
      const result = await uploadKnowledgeDocument(projectId, file);
      setNotice(`Indexed ${result.data.filename} into ${result.data.chunkCount} searchable passages.`);
    } catch (error) { setNotice(getApiError(error)); }
    finally { setUploading(false); }
  };

  return <div className="page-stack ai-page">
    <div className="page-heading"><div><div className="eyebrow">GROUNDED DATA INTELLIGENCE</div><h1>AI workspace</h1><p>Ask questions by typing or voice. Answers use your project data and indexed documents.</p></div><div className="ai-model-pill"><Sparkles size={15}/> Gemini AI</div></div>
    {!projectId && <div className="demo-banner"><Database size={16}/> Upload a CSV dataset first to enable project chat and dataset analysis.</div>}
    <div className="ai-layout">
      <aside className="ai-knowledge panel">
        <div className="knowledge-heading"><BookOpen size={18}/><h3>Workspace</h3></div>
        <button className="secondary-button knowledge-upload" onClick={newChat} disabled={!projectId}><Plus size={15}/> New conversation</button>
        <div className="ai-session-list"><strong>Recent conversations</strong>
          {sessions.map(session=><button key={session.id} className={sessionId===session.id?"active":""} onClick={()=>openSession(session.id)}><MessageSquare size={14}/><span>{session.title || "New conversation"}</span></button>)}
          {sessions.length===0&&<small>Your conversations will appear here.</small>}
        </div>
        <div className="knowledge-heading ai-knowledge-subhead"><BookOpen size={17}/><h3>Knowledge base</h3></div>
        <p>Upload project documentation, data dictionaries, specifications and PDF notes for grounded retrieval.</p>
        <input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" hidden onChange={upload}/>
        <button className="secondary-button knowledge-upload" disabled={!projectId||uploading} onClick={()=>fileRef.current?.click()}>{uploading?<LoaderCircle className="spin" size={16}/>:<Paperclip size={16}/>} {uploading?"Indexing…":"Add document"}</button>
        <div className="knowledge-hint"><FileText size={15}/> PDF, TXT, or Markdown · max 10 MB</div>
        {notice&&<div className="ai-notice">{notice}</div>}
        <div className="knowledge-note"><strong>How it works</strong><span>Questions are routed to read-only dataset tools and relevant document passages. Provider credentials stay on the backend.</span></div>
      </aside>
      <section className="ai-chat panel">
        <div className="chat-header"><div className="chat-avatar"><Bot size={19}/></div><div><strong>DataLens assistant</strong><span>Grounded answers · Read-only analysis</span></div><span className="online-dot">● Ready</span></div>
        <div className="chat-messages" ref={messageListRef}>
          {messages.map((message,index)=><div className={"chat-message "+message.role} key={message.id||index}>
            <div className="message-avatar">{message.role==="assistant"?<Bot size={16}/>:"You"}</div>
            <div className="message-body">{message.streaming && !message.content
              ? <div className="typing-indicator"><i/><i/><i/> Thinking…</div>
              : <div className={"message-content " + (message.streaming ? "streaming-content" : "")}>{message.content}</div>}
              {message.toolUsed&&message.toolUsed!=="none"&&<div className="tool-used"><Sparkles size={12}/> Data tool: {message.toolUsed.replaceAll("_"," ")}</div>}
              {message.sources?.length>0&&<div className="source-list"><strong>Sources</strong>{message.sources.map(source=><span key={source.citation}><FileText size={12}/> [{source.citation}] {source.filename} · passage {source.chunkIndex+1}</span>)}</div>}
            </div>
          </div>)}
        </div>
        {voiceError&&<div className="voice-error" role="status">{voiceError}</div>}
        {listening&&<div className="voice-listening" role="status"><span/> Listening… Speak, then press the microphone again to stop.</div>}
        <form className="chat-composer" onSubmit={send}>
          <textarea value={question} onChange={event=>setQuestion(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();send();}}} placeholder={projectId?"Ask about quality issues, schema, relationships, or documents…":"Upload a dataset to start asking questions…"} disabled={!projectId||busy} rows={2}/>
          <button type="button" className={"voice-button "+(listening?"recording":"")} onClick={listening?stopVoice:startVoice} disabled={!projectId||busy} title={listening?"Stop voice input":"Start voice input"} aria-label={listening?"Stop voice input":"Start voice input"}>{listening?<MicOff size={17}/>:<Mic size={17}/>}</button>
          <button className="primary-button send-button" type="submit" disabled={!projectId||busy||!question.trim()}><Send size={16}/></button>
        </form>
        <div className="chat-disclaimer">Speech is converted to text in your browser. Requests go to your DataLens backend; verify important findings against dataset evidence.</div>
      </section>
    </div>
  </div>;
}
