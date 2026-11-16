// tests/unit/credits.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Types } from "mongoose";
import { UserModel } from "../../src/models/User.js";
import { CreditLedgerModel } from "../../src/models/CreditLedger.js";
import { GenerationJobModel } from "../../src/models/GenerationJob.js";
import {
  consumeCredit,
  refundJobCredits,
} from "../../src/services/credits.service.js";

describe("credits.service", () => {
  beforeEach(() => {
    // no-op
  });

  test("20 parallel consumeCredit with balance 1 → exactly one succeeds", async () => {
    let balance = 1;
    let ledgerCreated = 0;

    (
      UserModel as unknown as {
        findOneAndUpdate: unknown;
      }
    ).findOneAndUpdate = (() => ({
      lean: async () => {
        if (balance > 0) {
          balance -= 1;
          return {
            _id: new Types.ObjectId(),
            credits: { imageFlux3: balance + 1 },
          };
        }
        return null;
      },
    })) as unknown as typeof UserModel.findOneAndUpdate;

    (
      CreditLedgerModel as unknown as {
        create: unknown;
      }
    ).create = (async () => {
      ledgerCreated += 1;
      return {};
    }) as unknown as typeof CreditLedgerModel.create;

    const userId = new Types.ObjectId();
    const jobId = new Types.ObjectId().toString();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        consumeCredit(userId, "imageFlux3", jobId),
      ),
    );

    const successes = results.filter((r) => r === true).length;
    expect(successes).toBe(1);
    expect(ledgerCreated).toBe(1);
  });

  test("refundJobCredits is idempotent (only one ledger row even when called twice)", async () => {
    let modifiedCount = 1;
    let ledgerCreated = 0;
    let userIncrements = 0;

    (GenerationJobModel as unknown as { updateOne: unknown }).updateOne =
      (async () => {
        const result = { modifiedCount };
        modifiedCount = 0; // second call sees 0
        return result;
      }) as unknown as typeof GenerationJobModel.updateOne;

    (UserModel as unknown as { updateOne: unknown }).updateOne = (async () => {
      userIncrements += 1;
      return { modifiedCount: 1 };
    }) as unknown as typeof UserModel.updateOne;

    (CreditLedgerModel as unknown as { create: unknown }).create =
      (async () => {
        ledgerCreated += 1;
        return {};
      }) as unknown as typeof CreditLedgerModel.create;

    const job = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      creditCost: { imageFlux3: 1, videoCosmos: 0 },
    };

    await refundJobCredits(job);
    await refundJobCredits(job);

    expect(userIncrements).toBe(1);
    expect(ledgerCreated).toBe(1);
  });
});
