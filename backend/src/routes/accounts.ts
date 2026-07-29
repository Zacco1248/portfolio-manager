import { Router } from 'express';
import { accountCreateSchema, accountUpdateSchema, idParam } from '@portfolio/shared';
import {
  accountUsage,
  createAccount,
  deleteAccount,
  findAccountByName,
  getAccount,
  listAccounts,
  toAccountDto,
  updateAccount,
} from '../services/accounts.js';
import { conflict, notFound } from '../lib/errors.js';

export const accountsRouter = Router();

accountsRouter.get('/', (req, res) => {
  res.json(listAccounts(req.query.includeArchived === 'true'));
});

accountsRouter.post('/', (req, res, next) => {
  const parsed = accountCreateSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  if (findAccountByName(parsed.data.name)) {
    return next(conflict(`Konto o nazwie "${parsed.data.name}" już istnieje`));
  }

  res.status(201).json(toAccountDto(createAccount(parsed.data), 0));
});

accountsRouter.patch('/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);
  const parsed = accountUpdateSchema.safeParse(req.body);
  if (!parsed.success) return next(parsed.error);

  if (!getAccount(id.data)) return next(notFound('Nie ma takiego konta'));

  if (parsed.data.name !== undefined) {
    const clash = findAccountByName(parsed.data.name);
    if (clash && clash.id !== id.data) {
      return next(conflict(`Konto o nazwie "${parsed.data.name}" już istnieje`));
    }
  }

  res.json(toAccountDto(updateAccount(id.data, parsed.data)));
});

accountsRouter.delete('/:id', (req, res, next) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return next(id.error);

  if (!getAccount(id.data)) return next(notFound('Nie ma takiego konta'));

  /*
   * Schemat ma ON DELETE SET NULL, więc baza sama by tu nie zaprotestowała —
   * transakcje przeżyłyby, tracąc tylko przypisanie. Mimo to odmawiamy:
   * ciche wyzerowanie konta na kilkuset transakcjach jest nieodwracalne
   * bez ponownego importu, a użytkownik zwykle chce archiwizacji.
   */
  const usage = accountUsage(id.data);
  const total = usage.transactions + usage.bonds;
  if (total > 0) {
    const parts = [
      usage.transactions > 0 ? `${usage.transactions} transakcji` : null,
      usage.bonds > 0 ? `${usage.bonds} zakupów obligacji` : null,
    ].filter(Boolean);
    return next(
      conflict(`Konto ma ${parts.join(' i ')}. Zarchiwizuj je zamiast usuwać.`, usage),
    );
  }

  deleteAccount(id.data);
  res.json({ ok: true });
});
