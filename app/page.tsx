import { redirect } from 'next/navigation';

/** The demo starts at Trip Setup, which is screen 01 of the pitch. */
export default function Home() {
  redirect('/setup');
}
