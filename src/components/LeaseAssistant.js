import { useQueryClient } from '@tanstack/react-query';
import DocAssistant from './DocAssistant';
import { askLease, updateLease } from '../lib/api';

// Lease-specific wiring around the generic DocAssistant. Works for a live lease
// (leaseId + canSave) and an archived/expired lease (leaseText only, read-only).
const SUGGESTED = [
  'What is the annual base rent?',
  'Is there a renewal option, and when is notice due?',
  'When does the lease term end?',
  'Who pays for the roof and CAM?',
];

export default function LeaseAssistant({ leaseId, leaseText, canSave = false }) {
  const qc = useQueryClient();
  return (
    <DocAssistant
      label="lease"
      docText={leaseText}
      suggested={SUGGESTED}
      canSave={canSave}
      ask={(question) => askLease(leaseId, question, leaseText)}
      onSave={async (text) => {
        await updateLease(leaseId, { lease_text: text });
        qc.invalidateQueries({ queryKey: ['lease', leaseId] });
      }}
    />
  );
}
