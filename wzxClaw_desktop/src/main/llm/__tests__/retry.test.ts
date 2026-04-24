import { describe, it, expect } from 'vitest'
import { classifyError, PromptTooLongError, AuthError } from '../retry'

describe('classifyError', () => {
  describe('rate limit (retryable)', () => {
    it('classifies 429 status code', () => {
      expect(classifyError('HTTP 429 Too Many Requests').classification).toBe('retryable')
    })

    it('classifies rate_limit keyword', () => {
      expect(classifyError('rate_limit exceeded').classification).toBe('retryable')
    })

    it('classifies too many requests', () => {
      expect(classifyError('too many requests, slow down').classification).toBe('retryable')
    })

    it('extracts retry-after seconds from message', () => {
      const result = classifyError('rate limit hit, retry after 30s')
      expect(result.classification).toBe('retryable')
      expect(result.retryAfterMs).toBe(30000)
    })
  })

  describe('server errors (retryable)', () => {
    it('classifies 500', () => {
      expect(classifyError('Internal server error 500').classification).toBe('retryable')
    })

    it('classifies 503 service unavailable', () => {
      expect(classifyError('503 service unavailable').classification).toBe('retryable')
    })

    it('classifies overloaded', () => {
      expect(classifyError('API is overloaded, please try again').classification).toBe('retryable')
    })
  })

  describe('network errors (retryable)', () => {
    it('classifies ECONNRESET', () => {
      expect(classifyError('read ECONNRESET').classification).toBe('retryable')
    })

    it('classifies fetch failed', () => {
      expect(classifyError('fetch failed').classification).toBe('retryable')
    })

    it('classifies network error (English)', () => {
      expect(classifyError('network error occurred').classification).toBe('retryable')
    })

    it('classifies 网络错误 (Chinese, GLM-5)', () => {
      expect(classifyError('网络错误，请稍后重试').classification).toBe('retryable')
    })
  })

  describe('JSON error body from GLM-5', () => {
    it('extracts inner message and classifies 网络错误 as retryable', () => {
      const jsonBody = JSON.stringify({
        type: 'error',
        error: { message: '网络错误，错误id：20260424abc，请稍后重试', code: '1234' },
        request_id: 'req-xyz',
      })
      const result = classifyError(jsonBody)
      expect(result.classification).toBe('retryable')
    })

    it('extracts inner message and classifies rate limit from JSON body', () => {
      const jsonBody = JSON.stringify({
        type: 'error',
        error: { message: 'rate_limit exceeded, please retry after 10s', code: '429' },
      })
      const result = classifyError(jsonBody)
      expect(result.classification).toBe('retryable')
      expect(result.retryAfterMs).toBe(10000)
    })

    it('extracts inner message and classifies auth error from JSON body', () => {
      const jsonBody = JSON.stringify({
        type: 'error',
        error: { message: 'invalid_api_key provided', code: '1301' },
      })
      const result = classifyError(jsonBody)
      expect(result.classification).toBe('auth')
    })

    it('falls back to non_retryable for unknown JSON error', () => {
      const jsonBody = JSON.stringify({
        type: 'error',
        error: { message: 'unknown model specified', code: '1002' },
      })
      const result = classifyError(jsonBody)
      expect(result.classification).toBe('non_retryable')
    })

    it('treats JSON without error.message as plain string (non_retryable)', () => {
      const jsonBody = JSON.stringify({ status: 'fail', reason: 'something' })
      const result = classifyError(jsonBody)
      // 没有 error.message，effectiveMsg 回退到原始 JSON 字符串
      expect(result.classification).toBe('non_retryable')
    })
  })

  describe('prompt too long (not retryable)', () => {
    it('classifies prompt_too_long', () => {
      expect(classifyError('prompt_too_long: exceeds limit').classification).toBe('prompt_too_long')
    })

    it('classifies context_length_exceeded', () => {
      expect(classifyError('context_length_exceeded').classification).toBe('prompt_too_long')
    })

    it('classifies maximum context length', () => {
      expect(classifyError("This model's maximum context length is 8192 tokens").classification).toBe('prompt_too_long')
    })
  })

  describe('auth errors (not retryable)', () => {
    it('classifies 401', () => {
      expect(classifyError('HTTP 401 Unauthorized').classification).toBe('auth')
    })

    it('classifies invalid_api_key', () => {
      expect(classifyError('invalid_api_key').classification).toBe('auth')
    })

    it('classifies forbidden', () => {
      expect(classifyError('403 Forbidden').classification).toBe('auth')
    })
  })

  describe('non-retryable errors', () => {
    it('classifies unknown 4xx as non_retryable', () => {
      expect(classifyError('HTTP 400 Bad Request: unknown parameter').classification).toBe('non_retryable')
    })

    it('classifies empty string as non_retryable', () => {
      expect(classifyError('').classification).toBe('non_retryable')
    })
  })
})

describe('PromptTooLongError', () => {
  it('has correct name', () => {
    const err = new PromptTooLongError()
    expect(err.name).toBe('PromptTooLongError')
    expect(err.message).toBe('Prompt too long')
  })

  it('accepts custom message', () => {
    const err = new PromptTooLongError('custom message')
    expect(err.message).toBe('custom message')
  })
})

describe('AuthError', () => {
  it('has correct name', () => {
    const err = new AuthError()
    expect(err.name).toBe('AuthError')
    expect(err.message).toBe('Authentication failed')
  })
})
