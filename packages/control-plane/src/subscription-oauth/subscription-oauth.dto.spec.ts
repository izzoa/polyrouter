import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OauthStartDto } from './subscription-oauth.dto';

// The global ValidationPipe uses these options (app.setup); a constraint failure here
// is exactly what maps to a 400 at the HTTP boundary.
const PIPE = { whitelist: true, forbidNonWhitelisted: true } as const;

async function propsWithErrors(obj: Record<string, unknown>): Promise<string[]> {
  const errs = await validate(plainToInstance(OauthStartDto, obj), PIPE);
  return errs.map((e) => e.property);
}

describe('OauthStartDto (allow-preset-client-identity)', () => {
  it('accepts a bare start, an explicit boolean opt-in either way, and a name', async () => {
    expect(await propsWithErrors({ preset: 'claude' })).toEqual([]);
    expect(await propsWithErrors({ preset: 'claude', imitateClientIdentity: true })).toEqual([]);
    expect(await propsWithErrors({ preset: 'claude', imitateClientIdentity: false })).toEqual([]);
    expect(
      await propsWithErrors({ preset: 'claude', name: 'mine', imitateClientIdentity: true }),
    ).toEqual([]);
  });

  it('rejects a null or non-boolean opt-in (a 400, never coerced to false)', async () => {
    expect(await propsWithErrors({ preset: 'claude', imitateClientIdentity: null })).toEqual([
      'imitateClientIdentity',
    ]);
    expect(await propsWithErrors({ preset: 'claude', imitateClientIdentity: 'true' })).toEqual([
      'imitateClientIdentity',
    ]);
  });

  it.each(['clientIdentity', 'extraHeaders', 'userAgent'])(
    'rejects %s: a connect start cannot supply identity values',
    async (field) => {
      expect(await propsWithErrors({ preset: 'claude', [field]: { 'User-Agent': 'x' } })).toEqual([
        field,
      ]);
      expect(await propsWithErrors({ preset: 'claude', [field]: 'x' })).toEqual([field]);
    },
  );
});
