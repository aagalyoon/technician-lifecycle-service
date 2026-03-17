import pino from 'pino';

export const logger = pino({
  level: 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

interface MockTechnician {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phoneNumber: string | null;
  active: boolean;
  createdOn: string;
  modifiedOn: string;
}

/**
 * Mock data designed to exercise every scenario from the case study:
 *
 * 1. Technician departs, phone reassigned to new hire (Carlos → Maria)
 * 2. Technician departs, ambiguous phone situation (Bob - phone deactivated)
 * 3. New tech has phone belonging to active user at DIFFERENT company (Dave has Diana's #)
 * 4. New tech with clean onboarding (Frank)
 * 5. Stable active tech (Jane, Diana)
 */
export const tenantData: Record<string, MockTechnician[]> = {
  // ── Tenant 100: Apex Plumbing & HVAC ──
  'tenant-100': [
    {
      id: 101,
      name: 'Jane Doe',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@apex.com',
      phoneNumber: '(555) 123-4567', // Still active, no change
      active: true,
      createdOn: '2023-01-15T00:00:00Z',
      modifiedOn: '2024-12-01T00:00:00Z',
    },
    {
      id: 102,
      name: 'Bob Smith',
      firstName: 'Bob',
      lastName: 'Smith',
      email: 'bob@apex.com',
      phoneNumber: '555-987-6543', // DEACTIVATED - simulates departure
      active: false,
      createdOn: '2023-03-20T00:00:00Z',
      modifiedOn: '2025-01-10T00:00:00Z',
    },
    {
      id: 103,
      name: 'Carlos Rivera',
      firstName: 'Carlos',
      lastName: 'Rivera',
      email: 'carlos@apex.com',
      phoneNumber: '+1 555 555 0001', // DEACTIVATED - his phone will go to Maria
      active: false,
      createdOn: '2023-06-01T00:00:00Z',
      modifiedOn: '2025-01-12T00:00:00Z',
    },
    {
      id: 104,
      name: 'Maria Garcia',
      firstName: 'Maria',
      lastName: 'Garcia',
      email: 'maria@apex.com',
      phoneNumber: '5555550001', // Carlos's old phone, reassigned by the company
      active: true,
      createdOn: '2025-01-15T00:00:00Z',
      modifiedOn: '2025-01-15T00:00:00Z',
    },
    {
      id: 105,
      name: 'Dave Wilson',
      firstName: 'Dave',
      lastName: 'Wilson',
      email: 'dave@apex.com',
      phoneNumber: '(555) 222-3333', // CONFLICT: This is Diana Chen's phone at Elite Electrical!
      active: true,
      createdOn: '2025-01-18T00:00:00Z',
      modifiedOn: '2025-01-18T00:00:00Z',
    },
  ],

  // ── Tenant 200: Elite Electrical Services ──
  'tenant-200': [
    {
      id: 201,
      name: 'Diana Chen',
      firstName: 'Diana',
      lastName: 'Chen',
      email: 'diana@elite.com',
      phoneNumber: '+15552223333', // Active - Dave Wilson at Apex has the same phone!
      active: true,
      createdOn: '2023-02-01T00:00:00Z',
      modifiedOn: '2024-11-20T00:00:00Z',
    },
    {
      id: 202,
      name: 'Erik Johnson',
      firstName: 'Erik',
      lastName: 'Johnson',
      email: 'erik@elite.com',
      phoneNumber: '555.333.4444', // DEACTIVATED
      active: false,
      createdOn: '2023-04-10T00:00:00Z',
      modifiedOn: '2025-01-08T00:00:00Z',
    },
    {
      id: 203,
      name: 'Frank Lee',
      firstName: 'Frank',
      lastName: 'Lee',
      email: 'frank@elite.com',
      phoneNumber: '(555) 777-8888', // New hire, clean phone - should auto-onboard
      active: true,
      createdOn: '2025-01-20T00:00:00Z',
      modifiedOn: '2025-01-20T00:00:00Z',
    },
  ],
};
