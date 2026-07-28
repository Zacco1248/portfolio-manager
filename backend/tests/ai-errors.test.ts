import { describe, expect, it } from 'vitest';
import { explainAiError } from '../src/services/ai.js';

describe('tłumaczenie błędów dostawcy modelu', () => {
  it('odrzucony klucz wskazuje zmienną środowiskową właściwą dla dostawcy', () => {
    expect(explainAiError('401 Unauthorized', 'anthropic')).toContain('ANTHROPIC_API_KEY');
    expect(explainAiError('invalid_api_key', 'openai')).toContain('OPENAI_API_KEY');
  });

  it('nieznany model kieruje do wyboru modelu, nie do klucza', () => {
    const message = explainAiError('404 model_not_found', 'openai');
    expect(message).toContain('modelu');
    expect(message).not.toContain('API_KEY');
  });

  it('rozróżnia limit zapytań od braku środków', () => {
    expect(explainAiError('429 rate limit exceeded', 'anthropic')).toContain('limit');
    expect(explainAiError('Your credit balance is too low', 'anthropic')).toContain('środków');
  });

  it('problem sieciowy wskazuje na serwer, nie na konfigurację dostawcy', () => {
    expect(explainAiError('getaddrinfo ENOTFOUND api.openai.com', 'openai')).toContain('internetu');
    expect(explainAiError('The operation was aborted due to timeout', 'openai')).toContain('czas');
  });

  it('nierozpoznany błąd przekazuje oryginalną treść', () => {
    expect(explainAiError('coś zupełnie nowego', 'anthropic')).toContain('coś zupełnie nowego');
  });
});
