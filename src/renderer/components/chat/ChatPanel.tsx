/**
 * ChatPanel — placeholder component for the right sidebar chat panel (per D-57).
 * Full UI implementation in Plan 02. This establishes the layout slot.
 */
export default function ChatPanel(): JSX.Element {
  return (
    <div className="chat-panel">
      <div className="chat-header">Chat</div>
      <div className="chat-messages">Messages will appear here</div>
    </div>
  )
}
