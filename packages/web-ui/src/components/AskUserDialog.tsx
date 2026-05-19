import { useState, useEffect, useCallback } from 'react'
import { useDataSource } from '../providers/DataSourceProvider'

interface AskUserState {
  questionId: string
  question: string
  choices?: string[]
}

export default function AskUserDialog(): React.ReactElement | null {
  const ds = useDataSource()
  const [pending, setPending] = useState<AskUserState | null>(null)
  const [answer, setAnswer] = useState('')

  useEffect(() => {
    if (!ds) return
    // 监听 ask-user:question 事件
    const unsub = ds.onStreamEvent?.('ask-user' as any, ((data: any) => {
      if (data.questionId && data.question) {
        setPending({ questionId: data.questionId, question: data.question, choices: data.choices })
        setAnswer('')
      }
    }) as any)
    return unsub
  }, [ds])

  const handleAnswer = useCallback(async () => {
    if (!pending || !ds?.answerAskUser) return
    await ds.answerAskUser(pending.questionId, answer)
    setPending(null)
    setAnswer('')
  }, [pending, answer, ds])

  const handleChoice = useCallback(async (choice: string) => {
    if (!pending || !ds?.answerAskUser) return
    await ds.answerAskUser(pending.questionId, choice)
    setPending(null)
    setAnswer('')
  }, [pending, ds])

  if (!pending) return null

  return (
    <div className="ask-user-overlay">
      <div className="ask-user-dialog">
        <p className="ask-user-question">{pending.question}</p>
        {pending.choices ? (
          <div className="ask-user-choices">
            {pending.choices.map(choice => (
              <button key={choice} onClick={() => handleChoice(choice)}>{choice}</button>
            ))}
          </div>
        ) : (
          <div className="ask-user-input">
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="输入回答..." onKeyDown={(e) => { if (e.key === 'Enter') handleAnswer() }} />
            <button onClick={handleAnswer}>发送</button>
          </div>
        )}
      </div>
    </div>
  )
}
