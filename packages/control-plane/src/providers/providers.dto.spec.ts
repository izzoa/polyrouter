import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateProviderDto,
  UpdateProviderDto,
  providerMaxTokensQuirks,
  resolveMaxTokensSpelling,
} from './providers.dto';

// The global ValidationPipe uses these options (app.setup); a constraint failure here
// is exactly what maps to a 400 at the HTTP boundary (validation.e2e-spec).
const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

async function propsWithErrors<T extends object>(
  cls: new () => T,
  obj: Record<string, unknown>,
): Promise<string[]> {
  const errs = await validate(plainToInstance(cls, obj), PIPE);
  return errs.map((e) => e.property);
}

const validCreate = {
  name: 'p',
  kind: 'api_key',
  protocol: 'openai_compatible',
  baseUrl: 'https://api.example/v1',
} as const;

describe('resolveMaxTokensSpelling', () => {
  it('passes an explicit value through unchanged', () => {
    expect(resolveMaxTokensSpelling('local', 'max_completion_tokens')).toBe('max_completion_tokens');
    expect(resolveMaxTokensSpelling('api_key', 'max_tokens')).toBe('max_tokens');
  });

  it('derives `auto` from kind — local→max_tokens, everything else→max_completion_tokens', () => {
    expect(resolveMaxTokensSpelling('local', 'auto')).toBe('max_tokens');
    for (const kind of ['api_key', 'subscription', 'custom'] as const) {
      expect(resolveMaxTokensSpelling(kind, 'auto')).toBe('max_completion_tokens');
    }
  });
});

describe('providerMaxTokensQuirks', () => {
  it('emits the resolved quirk only for openai_compatible', () => {
    expect(providerMaxTokensQuirks('openai_compatible', 'local', 'auto')).toEqual({
      maxTokensSpelling: 'max_tokens',
    });
    expect(providerMaxTokensQuirks('openai_compatible', 'api_key', 'auto')).toEqual({
      maxTokensSpelling: 'max_completion_tokens',
    });
  });

  it('is inert (undefined) for other protocols', () => {
    expect(providerMaxTokensQuirks('anthropic_compatible', 'local', 'max_tokens')).toBeUndefined();
    expect(providerMaxTokensQuirks('openai_responses', 'api_key', 'auto')).toBeUndefined();
  });
});

describe('maxTokensSpelling DTO validation (add-max-tokens-spelling)', () => {
  it('accepts each enum value and an omitted field on create', async () => {
    for (const v of ['auto', 'max_completion_tokens', 'max_tokens']) {
      expect(await propsWithErrors(CreateProviderDto, { ...validCreate, maxTokensSpelling: v })).not.toContain(
        'maxTokensSpelling',
      );
    }
    expect(await propsWithErrors(CreateProviderDto, { ...validCreate })).not.toContain(
      'maxTokensSpelling',
    );
  });

  it('rejects an invalid value and an explicit null on create (→ 400)', async () => {
    expect(
      await propsWithErrors(CreateProviderDto, { ...validCreate, maxTokensSpelling: 'bogus' }),
    ).toContain('maxTokensSpelling');
    expect(
      await propsWithErrors(CreateProviderDto, { ...validCreate, maxTokensSpelling: null }),
    ).toContain('maxTokensSpelling');
  });

  it('on update, an omitted field is fine but an explicit null is rejected', async () => {
    expect(await propsWithErrors(UpdateProviderDto, {})).not.toContain('maxTokensSpelling');
    expect(await propsWithErrors(UpdateProviderDto, { maxTokensSpelling: 'max_tokens' })).not.toContain(
      'maxTokensSpelling',
    );
    expect(await propsWithErrors(UpdateProviderDto, { maxTokensSpelling: null })).toContain(
      'maxTokensSpelling',
    );
  });
});
