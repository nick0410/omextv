#!/usr/bin/env node
/**
 * Credit coins by hand, and say in the ledger that that is what happened.
 *
 * For a payment that reached the bank account but never reached an order — the
 * buyer paid and closed the page, or the money arrived out of band. The coins
 * are real, so the balance should reflect them; the order was never matched to
 * a bank reference, so the record must not pretend it was.
 *
 * Deliberately does NOT approve the pending order with a made-up reference.
 * That would leave a row claiming a UTR that appears in no statement, and the
 * first time anyone reconciled the two they would be chasing a payment that
 * never had that id. The ledger reason is "adjustment", which is true.
 *
 *   node scripts/grant-coins.mjs <email> <coins> "<why>"
 */
import { PrismaClient } from "@prisma/client";

const [email, coinsArg, why] = process.argv.slice(2);

if (!email || !coinsArg) {
  console.error('usage: node scripts/grant-coins.mjs <email> <coins> "<why>"');
  process.exit(1);
}

const amount = Number(coinsArg);
if (!Number.isInteger(amount) || amount <= 0) {
  console.error(`coins must be a positive whole number, got "${coinsArg}"`);
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, username: true, coins: true },
  });
  if (!user) throw new Error(`no account with email ${email}`);

  console.log(`${user.username}: ${user.coins} coins before`);

  // Increment and ledger in one transaction, same as every other credit — a
  // manual grant is still money and still has to be reconstructable.
  const balance = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: user.id },
      data: { coins: { increment: amount } },
      select: { coins: true },
    });
    await tx.coinLedger.create({
      data: {
        userId: user.id,
        delta: amount,
        balanceAfter: updated.coins,
        reason: "adjustment",
        refId: why ? why.slice(0, 100) : "manual grant",
      },
    });
    return updated.coins;
  });

  console.log(`${user.username}: ${balance} coins after  (+${amount}, reason=adjustment)`);
}

main()
  .catch((err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
