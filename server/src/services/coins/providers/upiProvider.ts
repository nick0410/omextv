import { PaymentInstruction, PaymentProvider } from "../ports";
import { buildUpiRequest, isUpiConfigured, looksLikeUpiRef } from "../upi";

/**
 * Collecting money by handing the buyer a UPI request.
 *
 * The link-building itself stays in `upi.ts`, which knows about the format and
 * nothing about orders. This is the adapter that presents it as one way of
 * being paid among others.
 *
 * `confirmsAutomatically` is false, and it is the field that shapes everything
 * downstream: a direct transfer lands in a bank account and tells the server
 * nothing, so an order cannot be completed by the person who owes the money.
 */
export class UpiPaymentProvider implements PaymentProvider {
  readonly id = "upi";
  readonly confirmsAutomatically = false;

  isConfigured(): boolean {
    return isUpiConfigured();
  }

  /**
   * Nothing to ask anyone, so this resolves immediately. The signature is
   * async only because a gateway has to register the payment before the buyer
   * can make it.
   */
  async instructionFor(order: {
    id: string;
    amountPaise: number;
    description: string;
  }): Promise<PaymentInstruction> {
    const request = buildUpiRequest({
      amountPaise: order.amountPaise,
      reference: order.id,
      note: order.description,
    });

    return {
      kind: "transfer",
      provider: this.id,
      link: request.link,
      payee: request.payeeVpa,
      payeeName: request.payeeName,
      amountRupees: request.amountRupees,
      reference: request.reference,
    };
  }

  isPlausibleReference(value: string): boolean {
    return looksLikeUpiRef(value);
  }
}
