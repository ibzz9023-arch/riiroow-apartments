export const LEASE_AGREEMENT_CLAUSES = [
  {
    title: 'CLAUSE 1 – PURPOSE OF THE AGREEMENT',
    body: 'The premises shall be used exclusively for private residential purposes. The Tenant shall not use the apartment for illegal activities, commercial operations, or any purpose other than residential accommodation without written permission from the Landlord.',
  },
  {
    title: 'CLAUSE 2 – RENTAL PAYMENT',
    body: 'The Tenant shall pay the agreed monthly rent in full and on or before the agreed payment date each month. Payments shall be made through the payment methods approved by the Property Management. The Tenant shall retain payment confirmations as proof of payment.',
  },
  {
    title: 'CLAUSE 3 – LEASE DURATION',
    body: 'This agreement shall remain effective from the commencement date until the expiry date stated above. Any renewal or extension must be agreed upon by both parties in writing before the expiry of the existing agreement.',
  },
  {
    title: 'CLAUSE 4 – SECURITY DEPOSIT',
    body: 'The Tenant shall pay the agreed security deposit before taking possession of the apartment. The deposit shall serve as security against unpaid rent, unpaid utility bills, and damage beyond normal wear and tear. Any deductions must be justified and documented. The remaining balance shall be refunded after the apartment is inspected and outstanding obligations are settled.',
  },
  {
    title: 'CLAUSE 5 – MAINTENANCE AND REPAIRS',
    body: 'The Tenant shall keep the apartment clean and in good condition. The Landlord shall be responsible for major structural repairs and maintenance arising from normal deterioration. The Tenant shall be responsible for damage caused by negligence, misuse, or intentional actions by the Tenant or their visitors.',
  },
  {
    title: 'CLAUSE 6 – UTILITIES AND SERVICES',
    body: 'The Tenant shall pay for utilities and services assigned to the Tenant, including electricity, water, internet, and other personal services, unless otherwise agreed in writing. The Tenant must avoid wasting utilities or interfering with shared building services.',
  },
  {
    title: 'CLAUSE 7 – OCCUPANCY AND RESIDENTS',
    body: 'The apartment shall be occupied only by the Tenant and the approved household members declared to the Property Management. The Tenant shall not exceed the approved occupancy limit or allow unauthorized individuals to establish permanent residence in the apartment.',
  },
  {
    title: 'CLAUSE 8 – SUBLETTING AND TRANSFER',
    body: 'The Tenant shall not sublet, transfer, assign, or surrender possession of the apartment to another person without obtaining prior written approval from the Landlord.',
  },
  {
    title: 'CLAUSE 9 – ALTERATIONS AND MODIFICATIONS',
    body: 'The Tenant shall not make structural changes, install permanent fixtures, modify electrical or plumbing systems, or carry out renovations without prior written approval from the Landlord. Any approved modifications must be completed professionally and safely.',
  },
  {
    title: 'CLAUSE 10 – CLEANLINESS AND PROPERTY CARE',
    body: 'The Tenant shall maintain proper hygiene and cleanliness inside the apartment and its surrounding areas. Household waste must be disposed of in designated locations. The Tenant shall not damage common areas, corridors, staircases, parking spaces, or other shared facilities.',
  },
  {
    title: 'CLAUSE 11 – NOISE AND NEIGHBOUR CONDUCT',
    body: 'The Tenant shall respect other residents and avoid excessive noise, disturbances, harassment, or disruptive behaviour. Quiet hours and reasonable building regulations must be observed to maintain a peaceful residential environment.',
  },
  {
    title: 'CLAUSE 12 – ACCESS AND PROPERTY INSPECTION',
    body: 'The Landlord or authorized Property Management personnel may enter the apartment for inspections, repairs, maintenance, or emergencies. Except in emergencies, reasonable advance notice shall be provided and access shall be arranged at a reasonable time with the Tenant.',
  },
  {
    title: 'CLAUSE 13 – PROHIBITED ACTIVITIES',
    body: 'The Tenant shall not engage in unlawful activities, store dangerous or prohibited materials, cause fire hazards, or engage in activities that threaten the safety, security, or peaceful enjoyment of other residents and the property.',
  },
  {
    title: 'CLAUSE 14 – DAMAGE, LOSS AND LIABILITY',
    body: 'The Tenant shall promptly report any damage, water leakage, electrical fault, fire hazard, or other incident affecting the apartment. The Tenant shall be financially responsible for damage resulting from their negligence, misuse, or intentional misconduct, including that of their guests.',
  },
  {
    title: 'CLAUSE 15 – TERMINATION AND HANDOVER',
    body: 'Either party may terminate this agreement in accordance with the agreed notice period and applicable law. The Landlord may initiate termination for material breach, including persistent non-payment of rent, unauthorized subletting, or serious misconduct, subject to applicable legal procedures. Upon termination, the Tenant shall vacate the apartment, return all keys and access devices, settle outstanding payments, and hand over the apartment in reasonable condition, allowing for normal wear and tear.',
  },
  {
    title: 'CLAUSE 16 – GENERAL CONDITIONS AND DISPUTE RESOLUTION',
    body: 'Both parties agree to comply with this agreement and applicable laws. Any disagreement shall first be addressed through good-faith discussion between the Tenant and Property Management. If no resolution is reached, the dispute may be referred to the competent authorities or courts in accordance with applicable law. Any amendment to this agreement must be made in writing and signed by both parties.',
  },
];

export const LEASE_RENEWAL_STATEMENT = 'This Lease Agreement is a renewal of the previous lease term.';

export const isLeaseRenewal = (leaseOrSnapshot) => {
  const notes = String(leaseOrSnapshot?.notes ?? '');
  return /lease\s+renewed\s+from|renewal\s+of\s+the\s+previous\s+lease/i.test(notes);
};
