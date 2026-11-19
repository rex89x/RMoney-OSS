import { useQuery } from '@tanstack/react-query';
import { listAuditLogs } from './api';

export function useAuditLogs(max = 100) {
  return useQuery({
    queryKey: ['audit-logs', max],
    queryFn: () => listAuditLogs(max),
    staleTime: 60 * 1000,
  });
}
