import { useState, useRef, useEffect, useCallback } from 'react';
import type { KeyboardEvent, ChangeEvent, DragEvent } from 'react';
import { useAppContext } from '../context/AppContext';

interface PendingAttachment {
  name: string;
  type: string;
  data: string; // base64 data URL
  size: number;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_TYPES = [
  'image/*', 'audio/*', 'video/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/csv', 'text/markdown',
].join(',');

export function ChatInput() {
  const { sendMessage, isWaiting, connected, activeSessionId } = useAppContext();
  const [text, setText] = useState('');
  const [showCommands, setShowCommands] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when session changes
  useEffect(() => {
    if (textareaRef.current && connected) {
      textareaRef.current.focus();
    }
  }, [activeSessionId, connected]);

  const commands = [
    { cmd: '/new', desc: 'Start a new session' },
    { cmd: '/reset', desc: 'Reset current session' },
    { cmd: '/status', desc: 'Show gateway status' },
    { cmd: '/help', desc: 'Show available commands' }
  ];

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if ((!text.trim() && attachments.length === 0) || isWaiting || !connected) return;
    
    const msgText = text.trim() || (attachments.length > 0 ? `[${attachments.length} file${attachments.length > 1 ? 's' : ''} sent]` : '');
    const attachData = attachments.length > 0 
      ? attachments.map(a => ({ name: a.name, type: a.type, data: a.data }))
      : undefined;
    
    sendMessage(msgText, attachData);
    setText('');
    setAttachments([]);
    setShowCommands(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.focus();
    }
  };

  const handleInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    
    if (val === '/') {
      setShowCommands(true);
    } else if (showCommands && !val.startsWith('/')) {
      setShowCommands(false);
    }

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  };

  const insertCommand = (cmd: string) => {
    setText(cmd + ' ');
    setShowCommands(false);
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  // File handling
  const processFiles = useCallback((files: FileList | File[]) => {
    const fileArray = Array.from(files);
    for (const file of fileArray) {
      if (file.size > MAX_FILE_SIZE) {
        alert(`${file.name} is too large (max. 10 MB)`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments(prev => [...prev, {
          name: file.name,
          type: file.type || 'application/octet-stream',
          data: reader.result as string,
          size: file.size,
        }]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Drag & drop handlers
  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };
  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
  };
  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  // Paste handler for images
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        processFiles(files);
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [processFiles]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileIcon = (type: string) => {
    if (type.startsWith('image/')) return '🖼️';
    if (type.startsWith('audio/')) return '🎵';
    if (type.startsWith('video/')) return '🎬';
    if (type.includes('pdf')) return '📄';
    if (type.includes('word') || type.includes('document')) return '📝';
    if (type.startsWith('text/')) return '📃';
    return '📎';
  };

  const canSend = (text.trim() || attachments.length > 0) && connected && !isWaiting;

  return (
    <div 
      style={{ position: 'relative', width: '100%', maxWidth: '800px', margin: '0 auto' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragging && (
        <div style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(99, 102, 241, 0.15)',
          border: '2px dashed var(--color-primary)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 20,
          pointerEvents: 'none',
        }}>
          <span style={{ color: 'var(--color-primary)', fontWeight: 600, fontSize: '1.1em' }}>
            📎 Drop file here
          </span>
        </div>
      )}

      {showCommands && (
        <div 
          className="animate-fade-in"
          style={{ 
            position: 'absolute', 
            bottom: '100%', 
            left: 0, 
            right: 0, 
            backgroundColor: 'var(--color-surface)', 
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            marginBottom: 'var(--space-2)',
            padding: 'var(--space-2) 0',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 10
          }}
        >
          {commands.map(c => (
            <button
              key={c.cmd}
              onClick={() => insertCommand(c.cmd)}
              style={{
                display: 'flex',
                width: '100%',
                padding: 'var(--space-2) var(--space-4)',
                textAlign: 'left',
                alignItems: 'baseline',
                gap: 'var(--space-3)'
              }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'var(--color-surface-hover)'}
              onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              <span style={{ color: 'var(--color-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{c.cmd}</span>
              <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>{c.desc}</span>
            </button>
          ))}
        </div>
      )}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div style={{
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
          padding: '8px 12px',
          marginBottom: '4px',
          backgroundColor: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          borderBottom: 'none',
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
        }}>
          {attachments.map((att, i) => (
            <div key={i} style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 8px',
              backgroundColor: 'var(--color-bg-primary)',
              borderRadius: '6px',
              fontSize: '0.82em',
              maxWidth: '180px',
            }}>
              {att.type.startsWith('image/') ? (
                <img 
                  src={att.data} 
                  alt={att.name}
                  style={{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }}
                />
              ) : (
                <span style={{ fontSize: '1.3em' }}>{getFileIcon(att.type)}</span>
              )}
              <div style={{ overflow: 'hidden', minWidth: 0 }}>
                <div style={{ 
                  whiteSpace: 'nowrap', 
                  overflow: 'hidden', 
                  textOverflow: 'ellipsis',
                  color: 'var(--color-text-primary)',
                  fontWeight: 500,
                }}>{att.name}</div>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.85em' }}>
                  {formatSize(att.size)}
                </div>
              </div>
              <button
                onClick={() => removeAttachment(i)}
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  backgroundColor: 'var(--color-error, #ef4444)',
                  color: '#fff',
                  fontSize: '11px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  border: '2px solid var(--color-surface)',
                  lineHeight: 1,
                  padding: 0,
                }}
                title="Remove"
              >×</button>
            </div>
          ))}
        </div>
      )}
      
      <div 
        style={{ 
          display: 'flex', 
          alignItems: 'flex-end',
          backgroundColor: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: attachments.length > 0 ? '0 0 var(--radius-lg) var(--radius-lg)' : 'var(--radius-lg)',
          padding: 'var(--space-2)',
          gap: 'var(--space-2)'
        }}
      >
        {/* Attachment button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!connected}
          title="Attach file (image, PDF, audio, video...)"
          style={{
            padding: '6px 8px',
            borderRadius: 'var(--radius-md)',
            color: connected ? 'var(--color-text-secondary)' : 'var(--color-text-secondary)',
            opacity: connected ? 1 : 0.4,
            cursor: connected ? 'pointer' : 'not-allowed',
            fontSize: '1.2em',
            transition: 'all var(--transition-fast)',
            flexShrink: 0,
          }}
          onMouseOver={(e) => { if (connected) e.currentTarget.style.color = 'var(--color-primary)'; }}
          onMouseOut={(e) => e.currentTarget.style.color = 'var(--color-text-secondary)'}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_TYPES}
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) processFiles(e.target.files);
            e.target.value = ''; // reset so same file can be selected again
          }}
        />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={connected ? "Type a message, / for commands, 📎 for files..." : "Connecting..."}
          disabled={!connected}
          style={{
            flex: 1,
            minHeight: '24px',
            maxHeight: '120px',
            resize: 'none',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            padding: 'var(--space-2)',
            color: 'var(--color-text-primary)',
            fontFamily: 'var(--font-sans)',
            lineHeight: 1.5
          }}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          style={{
            padding: 'var(--space-2) var(--space-4)',
            backgroundColor: canSend ? 'var(--color-primary)' : 'var(--color-surface-hover)',
            color: canSend ? '#fff' : 'var(--color-text-secondary)',
            borderRadius: 'var(--radius-md)',
            fontWeight: 600,
            transition: 'all var(--transition-fast)',
            cursor: canSend ? 'pointer' : 'not-allowed'
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
