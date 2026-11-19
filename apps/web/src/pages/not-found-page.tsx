import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <p className="text-5xl font-bold text-muted-foreground">404</p>
      <p className="text-sm text-muted-foreground">找不到此頁面</p>
      <Button asChild><Link to="/">回到首頁</Link></Button>
    </div>
  );
}
