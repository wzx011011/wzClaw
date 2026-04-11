import React, { useState } from 'react'

// ============================================================
// AskUserQuestion — interactive question card rendered inline
// in the chat when the AskUserQuestion tool fires (Phase 4.2)
// ============================================================

interface AskUserOption {
  label: string
  description: string
}

interface AskUserQuestionProps {
  questionId: string
  question: string
  options: AskUserOption[]
  multiSelect: boolean
  onDismiss: (questionId: string) => void
}

export default function AskUserQuestion({
  questionId,
  question,
  options,
  multiSelect,
  onDismiss
}: AskUserQuestionProps): JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  const [showCustom, setShowCustom] = useState(false)
  const [customText, setCustomText] = useState('')
  const [answered, setAnswered] = useState(false)
  const [answeredWith, setAnsweredWith] = useState<string>('')

  const submit = (labels: string[], text?: string): void => {
    if (answered) return
    setAnswered(true)
    setAnsweredWith(labels.join(', ') + (text ? ` — ${text}` : ''))
    window.wzxclaw.answerUserQuestion({ questionId, selectedLabels: labels, customText: text }).catch(() => {})
    setTimeout(() => onDismiss(questionId), 800)
  }

  const handleSingleSelect = (label: string): void => {
    submit([label])
  }

  const handleToggle = (label: string): void => {
    setSelected((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
    )
  }

  const handleMultiSubmit = (): void => {
    if (showCustom && customText.trim()) {
      submit(['Other'], customText.trim())
    } else if (selected.length > 0) {
      submit(selected)
    }
  }

  const handleOtherSingle = (): void => {
    setShowCustom(true)
  }

  const handleOtherSubmit = (): void => {
    if (customText.trim()) {
      submit(['Other'], customText.trim())
    }
  }

  if (answered) {
    return (
      <div className="ask-user-question ask-user-answered-banner">
        <span className="ask-user-answered-label">Response sent:</span>
        <span className="ask-user-answered-text">{answeredWith}</span>
      </div>
    )
  }

  return (
    <div className="ask-user-question">
      <div className="ask-user-header">
        <span className="ask-user-icon">?</span>
        <span className="ask-user-title">Question from Agent</span>
      </div>
      <div className="ask-user-question-text">{question}</div>
      <div className="ask-user-options">
        {options.map((opt) =>
          multiSelect ? (
            <label
              key={opt.label}
              className={`ask-user-option${selected.includes(opt.label) ? ' selected' : ''}`}
            >
              <input
                type="checkbox"
                checked={selected.includes(opt.label)}
                onChange={() => handleToggle(opt.label)}
                disabled={answered}
              />
              <span className="ask-user-option-content">
                <span className="ask-user-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="ask-user-option-desc">{opt.description}</span>
                )}
              </span>
            </label>
          ) : (
            <button
              key={opt.label}
              className="ask-user-option ask-user-option-btn"
              onClick={() => handleSingleSelect(opt.label)}
              disabled={answered}
            >
              <span className="ask-user-option-label">{opt.label}</span>
              {opt.description && (
                <span className="ask-user-option-desc">{opt.description}</span>
              )}
            </button>
          )
        )}

        {/* "Other" option */}
        {multiSelect ? (
          <label
            className={`ask-user-option${showCustom ? ' selected' : ''}`}
          >
            <input
              type="checkbox"
              checked={showCustom}
              onChange={() => setShowCustom((v) => !v)}
              disabled={answered}
            />
            <span className="ask-user-option-content">
              <span className="ask-user-option-label">Other</span>
              <span className="ask-user-option-desc">Type a custom response</span>
            </span>
          </label>
        ) : (
          !showCustom && (
            <button
              className="ask-user-option ask-user-option-btn"
              onClick={handleOtherSingle}
              disabled={answered}
            >
              <span className="ask-user-option-label">Other</span>
              <span className="ask-user-option-desc">Type a custom response</span>
            </button>
          )
        )}
      </div>

      {showCustom && (
        <div className="ask-user-custom">
          <input
            className="ask-user-custom-input"
            placeholder="Type your response..."
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !multiSelect) {
                e.preventDefault()
                handleOtherSubmit()
              }
            }}
            disabled={answered}
            autoFocus
          />
          {!multiSelect && (
            <button
              className="ask-user-submit-btn"
              onClick={handleOtherSubmit}
              disabled={answered || !customText.trim()}
            >
              Submit
            </button>
          )}
        </div>
      )}

      {multiSelect && (
        <div className="ask-user-submit-row">
          <button
            className="ask-user-submit-btn"
            onClick={handleMultiSubmit}
            disabled={answered || (selected.length === 0 && !customText.trim())}
          >
            Submit
          </button>
        </div>
      )}
    </div>
  )
}
