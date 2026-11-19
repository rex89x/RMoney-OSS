import { TripList } from '@/features/trips';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { PlaneTakeoff } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function TripsPage() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="出遊"
        description="規劃行程、追蹤花費"
        actions={<Button asChild variant="outline"><Link to="/flights"><PlaneTakeoff className="size-4" />機票雷達</Link></Button>}
      />
      <TripList />
    </div>
  );
}
