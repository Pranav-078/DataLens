import { useEffect, useRef, useState } from "react";
import {
  Bot, FileText, Paperclip, Send, Sparkles, LoaderCircle, BookOpen,
  Database, Mic, MicOff, Plus, MessageSquare, Copy, Check,
  RefreshCw, CircleAlert, ArrowUpRight, WandSparkles
} from "lucide-react";
import {
  streamAiMessage, uploadKnowledgeDocument, listAiSessions,
  getAiSession, getApiError
} from "../services/api";

const suggestions = [
  {
    title: "Find data quality issues",
    prompt: "Analyze my dataset and identify the most important data quality issues. Explain their impact and suggest fixes."
  },
  {
    title: "Explain table relationships",
    prompt: "Explain the inferred relationships between my tables, including confidence and orphan records."
  },
  {
    title: "Summarize my schema",
    prompt: "Summarize my dataset schema, including tables, columns, and likely primary and foreign keys."
  },
  {
    title: "Review my quality score",
    prompt: "Explain my dataset's overall quality score and the main factors affecting it."
  }
];

function inlineContent(value) {
  return String(value).split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code className="ai-inline-code" key={index}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return <span key={index}>{part}</span>;
  });
}

function MessageContent({ content }) {
  const blocks = String(content || "").split(/(```[\s\S]*?```)/g);
  return <div className="ai-rich-content">
    {blocks.map((block, index) => {
      if (block.startsWith("```")) {
        const match = block.match(/^```([\w-]*)\r?\n?([\s\S]*?)```$/);
        const code = match ? match[2] : block.replace(/^```|\```$/g, "");
        const language = match?.[1] || "code";
        return <div className="ai-code-block" key={index}>
          <div className="ai-code-label"><span>{language}</span><span>Code</span></div>
          <pre><code>{code}</code></pre>
        </div>;
      }
      return <div className="ai-text-block" key={index}>
        {block.split(/\r?\n/).map((line, lineIndex) => {
          const trimmed = line.trim();
          if (!trimmed) return <div className="ai-line-space" key={lineIndex}/>;
          const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
          if (heading) return <h4 key={lineIndex}>{inlineContent(heading[2])}</h4>;
          const bullet = trimmed.match(/^[-*]\s+(.+)$/);
          if (bullet) return <div className="ai-list-row" key={lineIndex}><span>•</span><span>{inlineContent(bullet[1])}</span></div>;
          const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
          if (numbered) return <div className="ai-list-row numbered" key={lineIndex}><span>{trimmed.match(/^\d+/)[0]}.</span><span>{inlineContent(numbered[1])}</span></div>;
          return <p key={lineIndex}>{inlineContent(line)}</p>;
        })}
      </div>;
    })}
  </div>;
}

const friendlyError = error => {
  const message = getApiError(error);
  if (/No route matches.*ai\/chat\/stream|Cannot POST.*ai\/chat\/stream/i.test(message)) {
    return "The running DataLens API does not have the chat-stream route yet. Rebuild the API container with: docker compose up -d --build --no-deps api";
  }
  return message;
};

export function AiWorkspace({ projectId, versionId }) {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [copiedMessage, setCopiedMessage] = useState("");
  const fileRef = useRef(null);
  const recognitionRef = useRef(null);
  const messageListRef = useRef(null);
  const inputRef = useRef(null);

  const refreshSessions = async () => {
    if (!projectId) return;
    try {
      const response = await listAiSessions(projectId);
      setSessions(response.data.sessions || []);
    } catch (error) {
      setNotice(friendlyError(error));
    }
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
      setVoiceError("Speech recognition is not supported in this browser. You can still type your question.");
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
          "not-allowed": "Microphone permission was denied. Allow microphone access in your browser settings.",
          "no-speech": "No speech was detected. Please try again.",
          "audio-capture": "No microphone was detected by the browser."
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

  const sendQuestion = async rawQuestion => {
    const text = String(rawQuestion || "").trim();
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
      { id: streamId, role: "assistant", content: "", streaming: true }
    ]);

    try {
      await streamAiMessage(projectId, {
        question: text,
        versionId: versionId || undefined,
        sessionId: sessionId || undefined
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
            content: friendlyError(error),
            streaming: false,
            failed: true,
            retryText: text
          }
        : message));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const send = event => {
    event?.preventDefault();
    sendQuestion(question);
  };

  const newChat = () => {
    stopVoice();
    setSessionId("");
    setMessages([]);
    setQuestion("");
    setNotice("");
    setVoiceError("");
    inputRef.current?.focus();
  };

  const openSession = async id => {
    if (!id || busy) return;
    stopVoice();
    setNotice("");
    try {
      const response = await getAiSession(projectId, id);
      setSessionId(id);
      setMessages(response.data.messages?.length ? response.data.messages : []);
    } catch (error) {
      setNotice(friendlyError(error));
    }
  };

  const upload = async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    setNotice("");
    try {
      const result = await uploadKnowledgeDocument(projectId, file);
      setNotice(`Indexed ${result.data.filename} into ${result.data.chunkCount} searchable passages.`);
    } catch (error) {
      setNotice(friendlyError(error));
    } finally {
      setUploading(false);
    }
  };

  const copyAnswer = async message => {
    try {
      await navigator.clipboard.writeText(message.content || "");
      setCopiedMessage(message.id);
      window.setTimeout(() => setCopiedMessage(current => current === message.id ? "" : current), 1500);
    } catch {
      setNotice("Clipboard access is unavailable in this browser.");
    }
  };

  const handleInput = event => {
    setQuestion(event.target.value);
    event.target.style.height = "auto";
    event.target.style.height = Math.min(event.target.scrollHeight, 180) + "px";
  };

  const isEmpty = messages.length === 0;

  return <div className="page-stack ai-page">
    <div className="page-heading ai-page-heading">
      <div>
        <div className="eyebrow">DATA INTELLIGENCE ASSISTANT</div>
        <h1>AI workspace</h1>
        <p>Ask questions about your data, investigate quality issues, and explore relationships in natural language.</p>
      </div>
      <div className="ai-model-pill"><Sparkles size={15}/> Gemini-powered assistant</div>
    </div>

    {!projectId && <div className="demo-banner"><Database size={16}/> Upload a CSV dataset first to enable project chat and data analysis.</div>}

    <div className="ai-layout">
      <aside className="ai-knowledge panel">
        <div className="ai-sidebar-top">
          <div className="knowledge-heading"><MessageSquare size={17}/><h3>Your chats</h3></div>
          <button className="ai-new-chat" onClick={newChat} disabled={!projectId || busy}><Plus size={15}/> New chat</button>
        </div>

        <div className="ai-session-list">
          <strong>RECENT</strong>
          {sessions.map(session => <button key={session.id} className={sessionId === session.id ? "active" : ""} onClick={() => openSession(session.id)} disabled={busy}>
            <MessageSquare size={14}/><span>{session.title || "New conversation"}</span>
          </button>)}
          {sessions.length === 0 && <small>Your conversations will appear here.</small>}
        </div>

        <div className="ai-knowledge-card">
          <div className="knowledge-heading"><BookOpen size={17}/><h3>Knowledge base</h3></div>
          <p>Add reports, data dictionaries and project documents. The assistant can use relevant passages when answering.</p>
          <input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" hidden onChange={upload}/>
          <button className="secondary-button knowledge-upload" disabled={!projectId || uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <LoaderCircle className="spin" size={15}/> : <Paperclip size={15}/>}
            {uploading ? "Indexing document…" : "Add document"}
          </button>
          <div className="knowledge-hint"><FileText size={14}/> PDF, TXT or Markdown · max 10 MB</div>
        </div>

        <div className="knowledge-note"><strong><ShieldCheckIcon/> Private, grounded analysis</strong><span>Answers use the selected dataset and indexed documents. Verify important findings against source data.</span></div>
      </aside>

      <section className="ai-chat panel">
        <div className="chat-header">
          <div className="chat-avatar"><Bot size={19}/></div>
          <div className="chat-title"><strong>DataLens assistant</strong><span>Data-aware · Read-only analysis</span></div>
          <span className="chat-ready"><i/> Ready</span>
        </div>

        <div className={"chat-messages " + (isEmpty ? "is-empty" : "")} ref={messageListRef}>
          {isEmpty ? <div className="ai-welcome">
            <div className="ai-welcome-icon"><WandSparkles size={25}/></div>
            <h2>What would you like to understand?</h2>
            <p>Ask a question in plain language. I’ll use your uploaded dataset and documents to help investigate it.</p>
            <div className="ai-suggestion-grid">
              {suggestions.map(item => <button key={item.title} onClick={() => { setQuestion(item.prompt); inputRef.current?.focus(); }}>
                <span>{item.title}</span><ArrowUpRight size={14}/>
              </button>)}
            </div>
          </div> : messages.map((message, index) => <article className={"chat-message " + message.role} key={message.id || index}>
            {message.role === "assistant" && <div className="message-avatar"><Bot size={16}/></div>}
            <div className="message-body">
              <div className="message-role">{message.role === "assistant" ? "DataLens" : "You"}</div>
              {message.streaming && !message.content
                ? <div className="typing-indicator"><i/><i/><i/> Thinking…</div>
                : <div className={"message-content " + (message.failed ? "message-failed" : "")}>
                    <MessageContent content={message.content}/>
                  </div>}
              {message.toolUsed && message.toolUsed !== "none" && <div className="tool-used"><Sparkles size={12}/> Used data tool: {message.toolUsed.replaceAll("_", " ")}</div>}
              {message.sources?.length > 0 && <div className="source-list"><strong>Sources used</strong>{message.sources.map(source => <span key={source.citation}><FileText size={12}/> [{source.citation}] {source.filename} · passage {source.chunkIndex + 1}</span>)}</div>}
              {message.failed && <button className="ai-retry" onClick={() => sendQuestion(message.retryText)} disabled={busy}><RefreshCw size={13}/> Retry response</button>}
              {message.role === "assistant" && !message.streaming && !message.failed && message.content && <div className="message-actions">
                <button onClick={() => copyAnswer(message)} title="Copy answer" aria-label="Copy answer">{copiedMessage === message.id ? <Check size={13}/> : <Copy size={13}/>} {copiedMessage === message.id ? "Copied" : "Copy"}</button>
              </div>}
            </div>
          </article>)}
        </div>

        {notice && <div className="ai-notice" role="status"><CircleAlert size={15}/><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button></div>}
        {voiceError && <div className="voice-error" role="status">{voiceError}</div>}
        {listening && <div className="voice-listening" role="status"><span/> Listening… Speak, then press the microphone again to stop.</div>}

        <form className="chat-composer" onSubmit={send}>
          <textarea
            ref={inputRef}
            value={question}
            onChange={handleInput}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }}
            placeholder={projectId ? "Message DataLens… (Enter to send, Shift + Enter for a new line)" : "Upload a dataset to start asking questions…"}
            disabled={!projectId || busy}
            rows={1}
            aria-label="Message DataLens"
          />
          <button type="button" className={"voice-button " + (listening ? "recording" : "")} onClick={listening ? stopVoice : startVoice} disabled={!projectId || busy} title={listening ? "Stop voice input" : "Start voice input"} aria-label={listening ? "Stop voice input" : "Start voice input"}>
            {listening ? <MicOff size={17}/> : <Mic size={17}/>}
          </button>
          <button className="primary-button send-button" type="submit" disabled={!projectId || busy || !question.trim()} title="Send message" aria-label="Send message">
            {busy ? <LoaderCircle className="spin" size={17}/> : <Send size={16}/>}
          </button>
        </form>
        <div className="chat-disclaimer">DataLens uses Gemini to generate answers from your data. AI can make mistakes; verify important results.</div>
      </section>
    </div>
  </div>;
}

function ShieldCheckIcon() {
  return <Check size={14}/>;
}
