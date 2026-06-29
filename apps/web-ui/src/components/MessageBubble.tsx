import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../lib/api';

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const isError = message.isError;
  
  const bubbleContent = (
    <div 
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        flex: 1,
        minWidth: 0,
      }}
    >
      <div 
        style={{
          padding: 'var(--space-3) var(--space-4)',
          borderRadius: 'var(--radius-lg)',
          backgroundColor: isError ? 'rgba(239, 68, 68, 0.15)' : isUser ? 'var(--color-primary)' : 'var(--color-surface)',
          color: isError ? '#f87171' : isUser ? '#ffffff' : 'var(--color-text-primary)',
          border: isError ? '1px solid rgba(239, 68, 68, 0.3)' : 'none',
          borderBottomRightRadius: isUser ? '4px' : 'var(--radius-lg)',
          borderBottomLeftRadius: isUser ? 'var(--radius-lg)' : '4px',
          boxShadow: 'var(--shadow-sm)',
          lineHeight: 1.5,
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          overflow: 'hidden'
        }}
      >
        {isUser ? (
          <>
            {/* Attachment previews */}
            {message.attachments && message.attachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: message.text && !message.text.startsWith('[') ? '8px' : 0 }}>
                {message.attachments.map((att, i) => (
                  att.type.startsWith('image/') ? (
                    <img 
                      key={i}
                      src={att.data} 
                      alt={att.name}
                      style={{ 
                        maxWidth: '200px', 
                        maxHeight: '150px', 
                        borderRadius: '8px', 
                        objectFit: 'cover',
                        cursor: 'pointer',
                        border: '1px solid rgba(255,255,255,0.2)',
                      }}
                      onClick={() => window.open(att.data, '_blank')}
                      title={att.name}
                    />
                  ) : (
                    <div key={i} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '4px 8px',
                      backgroundColor: 'rgba(255,255,255,0.15)',
                      borderRadius: '6px',
                      fontSize: '0.85em',
                    }}>
                      <span>{att.type.startsWith('audio/') ? '🎵' : att.type.startsWith('video/') ? '🎬' : att.type.includes('pdf') ? '📄' : '📎'}</span>
                      <span style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
                    </div>
                  )
                ))}
              </div>
            )}
            {message.text && !message.text.startsWith('[') && (
              <div style={{ whiteSpace: 'pre-wrap' }}>{message.text}</div>
            )}
          </>
        ) : (
          <div className="markdown-body" style={{
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
          }}>
            <style>{`
              .markdown-body ol, .markdown-body ul {
                padding-left: 1.4em;
                margin: 0.3em 0;
              }
              .markdown-body p {
                margin: 0.3em 0;
              }
              .markdown-body p:first-child {
                margin-top: 0;
              }
              .markdown-body p:last-child {
                margin-bottom: 0;
              }
              .markdown-body table {
                border-collapse: collapse;
                width: 100%;
                margin: 0.5em 0;
                font-size: 0.9em;
                overflow-x: auto;
                display: block;
              }
              .markdown-body thead {
                background: rgba(139, 92, 246, 0.15);
              }
              .markdown-body th {
                font-weight: 600;
                text-align: left;
                padding: 6px 10px;
                border-bottom: 2px solid rgba(139, 92, 246, 0.3);
                white-space: nowrap;
              }
              .markdown-body td {
                padding: 5px 10px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                vertical-align: top;
              }
              .markdown-body tr:last-child td {
                border-bottom: none;
              }
              .markdown-body tr:hover {
                background: rgba(139, 92, 246, 0.06);
              }
              .markdown-body blockquote {
                border-left: 3px solid var(--color-primary);
                margin: 0.5em 0;
                padding: 0.3em 0.8em;
                color: var(--color-text-secondary);
              }
              .markdown-body hr {
                border: none;
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                margin: 0.6em 0;
              }
              .markdown-body h1, .markdown-body h2, .markdown-body h3 {
                margin: 0.5em 0 0.3em;
                font-weight: 600;
              }
              .markdown-body h1 { font-size: 1.2em; }
              .markdown-body h2 { font-size: 1.1em; }
              .markdown-body h3 { font-size: 1.0em; }
              .thinking-dots {
                display: inline-flex;
                gap: 4px;
                font-size: 1.2em;
              }
              .thinking-dots span {
                opacity: 0.3;
                animation: dot-pulse 1.4s ease-in-out infinite;
                color: var(--color-primary);
              }
              .thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
              .thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
              @keyframes dot-pulse {
                0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
                40% { opacity: 1; transform: scale(1.1); }
              }
            `}</style>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                pre: ({ ...props }) => (
                  <div style={{ position: 'relative', margin: 'var(--space-2) 0' }}>
                    <pre style={{ 
                      padding: 'var(--space-3)', 
                      backgroundColor: 'var(--color-bg-primary)', 
                      borderRadius: 'var(--radius-md)', 
                      overflowX: 'auto',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--font-size-sm)'
                    }} {...props} />
                  </div>
                ),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                code: ({ inline, ...props }: any) => {
                  return inline ? (
                    <code style={{ 
                      backgroundColor: 'var(--color-bg-primary)', 
                      padding: '2px 4px', 
                      borderRadius: '4px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.9em'
                    }} {...props} />
                  ) : (
                    <code {...props} />
                  );
                }
              }}
            >
              {message.text + (message.isStreaming ? ' ▊' : '')}
            </ReactMarkdown>
            {message.isStreaming && !message.text && (
              <span className="thinking-dots">
                <span>●</span><span>●</span><span>●</span>
              </span>
            )}
          </div>
        )}
      </div>
      <div 
        style={{ 
          fontSize: 'var(--font-size-xs)', 
          color: 'var(--color-text-secondary)',
          alignSelf: isUser ? 'flex-end' : 'flex-start',
          opacity: 0.8
        }}
      >
        {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        {!isUser && message.model && (
          <span style={{ opacity: 0.6 }}>
            {' · '}{message.provider || 'llm'}: {message.model}
          </span>
        )}
      </div>
    </div>
  );
  
  return (
    <div 
      className="animate-fade-in"
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '80%',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 'var(--space-2)',
      }}
    >
      {!isUser && (
        <img
          src="/ontofelia-avatar.jpg"
          alt="Ontofelia"
          style={{
            width: '32px',
            height: '32px',
            borderRadius: '50%',
            objectFit: 'cover',
            flexShrink: 0,
            marginTop: '4px',
          }}
        />
      )}
      {bubbleContent}
    </div>
  );
}
