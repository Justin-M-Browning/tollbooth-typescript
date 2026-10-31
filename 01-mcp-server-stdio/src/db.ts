export interface CustomerRecord {
  customer_id: string;
  name: string;
  email: string;
  tier: 'STANDARD' | 'PREMIUM' | 'ENTERPRISE';
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  account_balance: number;
  lifetime_spent: number;
  currency: string;
  created_at: string;
}

export interface RefundRecord {
  refund_id: string;
  customer_id: string;
  amount: number;
  currency: string;
  reason: string;
  status: 'PROCESSED' | 'PENDING_REVIEW';
  previous_balance: number;
  new_balance: number;
  processed_at: string;
}

class CustomerDatabase {
  private customers: Map<string, CustomerRecord> = new Map();
  private refunds: Map<string, RefundRecord[]> = new Map();

  constructor() {
    this.seed();
  }

  private seed(): void {
    const seedData: CustomerRecord[] = [
      {
        customer_id: 'CUST-10001',
        name: 'Sarah Connor',
        email: 'sarah.connor@cyberdyne.net',
        tier: 'ENTERPRISE',
        status: 'ACTIVE',
        account_balance: 1450.5,
        lifetime_spent: 12400.0,
        currency: 'USD',
        created_at: '2023-01-15T08:30:00Z',
      },
      {
        customer_id: 'CUST-20002',
        name: 'John Doe',
        email: 'john.doe@example.com',
        tier: 'PREMIUM',
        status: 'ACTIVE',
        account_balance: 320.0,
        lifetime_spent: 2800.75,
        currency: 'USD',
        created_at: '2023-05-20T14:15:00Z',
      },
      {
        customer_id: 'CUST-ABCDE',
        name: 'Jane Smith',
        email: 'jane.smith@domain.org',
        tier: 'STANDARD',
        status: 'ACTIVE',
        account_balance: 75.25,
        lifetime_spent: 540.0,
        currency: 'USD',
        created_at: '2024-02-10T11:00:00Z',
      },
    ];

    for (const cust of seedData) {
      this.customers.set(cust.customer_id, { ...cust });
      this.refunds.set(cust.customer_id, []);
    }
  }

  public getCustomer(customerId: string): CustomerRecord | null {
    const cust = this.customers.get(customerId);
    return cust ? { ...cust } : null;
  }

  public processRefund(customerId: string, amount: number, reason: string): RefundRecord {
    const cust = this.customers.get(customerId);
    const prevBalance = cust ? cust.account_balance : 0;
    const newBalance = cust ? prevBalance + amount : amount;

    if (cust) {
      cust.account_balance = newBalance;
    }

    const refund: RefundRecord = {
      refund_id: `REF-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 9000 + 1000)}`,
      customer_id: customerId,
      amount: Math.round(amount * 100) / 100,
      currency: cust ? cust.currency : 'USD',
      reason,
      status: amount > 10000 ? 'PENDING_REVIEW' : 'PROCESSED',
      previous_balance: prevBalance,
      new_balance: newBalance,
      processed_at: new Date().toISOString(),
    };

    const customerRefunds = this.refunds.get(customerId) || [];
    customerRefunds.push(refund);
    this.refunds.set(customerId, customerRefunds);

    return refund;
  }

  public reset(): void {
    this.customers.clear();
    this.refunds.clear();
    this.seed();
  }
}

export const db = new CustomerDatabase();
