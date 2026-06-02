import React, { useState, useEffect, useMemo } from 'react';
import { Mail, Settings, LogOut, Search, Plus, CreditCard, Loader2, ExternalLink, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { supabase } from './lib/supabase';
import type { User } from '@supabase/supabase-js';

// Fallback mock data with examples from May and June 2026
const mockTransactions = [
  { id: '1', merchant: 'Sample: Amazon India', amount: 1250.00, date: '2026-06-01T10:00:00Z', category: 'Shopping', email_message_id: '123', linked_accounts: { email_address: 'personal@gmail.com' } },
  { id: '2', merchant: 'Sample: Swiggy', amount: 345.50, date: '2026-06-02T14:30:00Z', category: 'Food', email_message_id: '456', linked_accounts: { email_address: 'work@gmail.com' } },
  { id: '3', merchant: 'Sample: Uber', amount: 500.00, date: '2026-05-28T09:15:00Z', category: 'Transport', email_message_id: '789', linked_accounts: { email_address: 'personal@gmail.com' } },
  { id: '4', merchant: 'Sample: Netflix', amount: 649.00, date: '2026-05-15T20:00:00Z', category: 'Entertainment', email_message_id: '101', linked_accounts: { email_address: 'shared@gmail.com' } },
  { id: '5', merchant: 'Sample: Zomato', amount: 890.00, date: '2026-05-02T19:45:00Z', category: 'Food', email_message_id: '102', linked_accounts: { email_address: 'personal@gmail.com' } },
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [isLoadingExpenses, setIsLoadingExpenses] = useState(false);
  const [linkedAccounts, setLinkedAccounts] = useState<any[]>([]);
  const [currentMonthIndex, setCurrentMonthIndex] = useState(0); // 0 is latest month

  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
      if (session?.user) {
        handleSession(session);
        fetchExpenses();
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        handleSession(session);
        fetchExpenses();
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleSession = async (session: any) => {
    if (session?.user && session?.provider_refresh_token) {
      // Ensure the user exists in our public.users table to satisfy the foreign key constraint
      await supabase.from('users').upsert({
        id: session.user.id,
        email: session.user.email
      });

      const { data } = await supabase
        .from('linked_accounts')
        .select('id')
        .eq('email_address', session.user.email)
        .maybeSingle();
        
      if (!data) {
        await supabase.from('linked_accounts').insert({
          user_id: session.user.id,
          email_address: session.user.email,
          google_refresh_token: session.provider_refresh_token
        });
      } else {
        await supabase.from('linked_accounts').update({
          google_refresh_token: session.provider_refresh_token
        }).eq('id', data.id);
      }
    }
  };

  const handleSync = async (silent = false) => {
    if (!silent) setIsSyncing(true);
    try {
      // Trigger the backend Edge Function (JWT is passed automatically)
      const { data, error } = await supabase.functions.invoke('sync-emails');
      if (error) throw error;
      
      if (!silent && data?.new_expenses_found > 0) alert(`Sync complete! Found ${data.new_expenses_found} new expenses.`);
      else if (!silent) alert("Sync complete! No new expenses found right now.");
      
      await fetchExpenses();
    } catch (err: any) {
      if (!silent) alert("Error syncing: " + err.message);
    } finally {
      setIsSyncing(false);
    }
  };

  // Auto-sync once on login (runs silently in the background)
  useEffect(() => {
    if (user) {
      handleSync(true);
    }
  }, [user]);

  const handleLogin = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { 
        redirectTo: window.location.origin,
        scopes: 'https://www.googleapis.com/auth/gmail.readonly',
        queryParams: { access_type: 'offline', prompt: 'consent' }
      }
    });
  };

  const handleLinkAnotherAccount = () => {
    if (!user) return;
    
    // Redirect directly to Google OAuth targeting our custom oauth-callback Edge Function
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    const redirectUri = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/oauth-callback`;
    const scope = 'https://www.googleapis.com/auth/gmail.readonly email profile';
    
    // We pass the user's ID in the state parameter so the backend knows who to link it to
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent&state=${user.id}`;
    
    // Open in a popup window
    window.open(authUrl, '_blank', 'width=500,height=600');
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setExpenses([]);
  };

  const fetchExpenses = async () => {
    setIsLoadingExpenses(true);
    const { data, error } = await supabase
      .from('expenses')
      .select(`*, linked_accounts ( email_address )`)
      .order('date', { ascending: false });
      
    if (data && data.length > 0) {
      setExpenses(data);
    }

    const { data: accounts } = await supabase.from('linked_accounts').select('*').order('created_at', { ascending: true });
    if (accounts) setLinkedAccounts(accounts);

    setIsLoadingExpenses(false);
  };

  const formatINR = (amount: number) => {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  };

  // Use real data only (removed mock data fallback)
  const rawData = expenses;
  const isMock = false;

  // Group all data into distinct months (e.g., "June 2026", "May 2026")
  // HOOK MUST BE ABOVE CONDITIONALS
  const availableMonths = useMemo(() => {
    const months = new Set<string>();
    rawData.forEach(exp => {
      const d = new Date(exp.date);
      months.add(d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }));
    });
    // Sort descending (newest first)
    return Array.from(months).sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  }, [rawData]);

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><Loader2 className="w-8 h-8 animate-spin text-slate-400" /></div>;
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-slate-50">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] p-8 border border-slate-100">
          <div className="text-center mb-8">
            <div className="w-12 h-12 bg-slate-900 rounded-xl flex items-center justify-center mx-auto mb-4">
              <Mail className="text-white w-6 h-6" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Welcome to SpendTracker</h1>
            <p className="text-slate-500 mt-2 text-sm">Sign in to sync your expenses</p>
          </div>
          
          <button onClick={handleLogin} className="w-full bg-white border border-slate-200 text-slate-800 py-2.5 px-4 rounded-xl flex items-center justify-center gap-3 hover:bg-slate-50 transition-colors shadow-sm font-medium">
             Continue with Google
          </button>
        </div>
      </div>
    );
  }

  // Ensure we don't go out of bounds if data changes
  const safeMonthIndex = Math.min(Math.max(0, currentMonthIndex), Math.max(0, availableMonths.length - 1));
  const selectedMonthString = availableMonths[safeMonthIndex] || new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  // Filter data to ONLY show transactions for the selected month
  const monthlyData = rawData.filter(exp => {
    const d = new Date(exp.date);
    return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) === selectedMonthString;
  });

  const totalSpend = monthlyData.reduce((sum, exp) => sum + Number(exp.amount), 0);

  // Group filtered data by day for the chart
  const chartData = monthlyData.reduce((acc, exp) => {
    const date = new Date(exp.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
    const existing = acc.find((item: any) => item.name === date);
    if (existing) {
      existing.spend += Number(exp.amount);
    } else {
      acc.push({ name: date, spend: Number(exp.amount) });
    }
    return acc;
  }, [] as any[]).reverse();

  return (
    <div className="min-h-screen flex bg-slate-50">
      <aside className="w-64 border-r border-slate-200 bg-white p-6 flex flex-col hidden md:flex">
        <div className="flex items-center gap-3 mb-10">
          <div className="w-8 h-8 bg-slate-900 rounded-lg flex items-center justify-center">
            <Mail className="text-white w-4 h-4" />
          </div>
          <span className="font-semibold text-lg tracking-tight">SpendTracker</span>
        </div>

        <nav className="flex-1 space-y-1">
          <a href="#" className="flex items-center gap-3 px-3 py-2.5 bg-slate-100 text-slate-900 rounded-lg text-sm font-medium">
            <CreditCard className="w-4 h-4" /> Dashboard
          </a>
        </nav>

        <div className="pt-6 border-t border-slate-100 mt-auto overflow-hidden">
          <div className="px-3 mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wider">Linked Accounts</div>
          <div className="max-h-32 overflow-y-auto mb-4 space-y-1">
            {linkedAccounts.map(account => (
               <div key={account.id} className="px-3 py-1.5 flex items-center gap-2 text-sm text-slate-600">
                  <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="truncate">{account.email_address}</span>
               </div>
            ))}
          </div>

          <div className="px-3 mt-4 mb-4 flex items-center gap-3 border-t border-slate-100 pt-4">
             {user.user_metadata.avatar_url && (
               <img src={user.user_metadata.avatar_url} className="w-8 h-8 rounded-full shrink-0" alt="avatar" />
             )}
             <div className="text-sm font-medium truncate">{user.user_metadata.full_name || user.email}</div>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-3 px-3 py-2.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg text-sm font-medium w-full transition-colors">
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 p-8 overflow-y-auto">
        <header className="flex justify-between items-center mb-10">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Overview</h1>
            <p className="text-sm text-slate-500 mt-1">Welcome back, {user.user_metadata.full_name?.split(' ')[0] || 'User'}</p>
          </div>
          
          <div className="flex items-center gap-3">
             <button onClick={handleLinkAnotherAccount} className="bg-slate-900 text-white px-4 py-2.5 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-slate-800 transition-colors shadow-sm">
               <Plus className="w-4 h-4" /> Link Gmail Account
             </button>
          </div>
        </header>

        {/* Month Selector */}
        <div className="flex items-center justify-between mb-8">
           <div className="flex items-center gap-4 bg-white px-4 py-2 rounded-xl border border-slate-200 shadow-sm">
              <button 
                 onClick={() => setCurrentMonthIndex(i => Math.min(availableMonths.length - 1, i + 1))}
                 disabled={safeMonthIndex >= availableMonths.length - 1}
                 className="p-1 text-slate-400 hover:text-slate-900 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
              >
                 <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="text-base font-semibold text-slate-900 min-w-[120px] text-center">
                 {selectedMonthString}
              </div>
              <button 
                 onClick={() => setCurrentMonthIndex(i => Math.max(0, i - 1))}
                 disabled={safeMonthIndex === 0}
                 className="p-1 text-slate-400 hover:text-slate-900 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
              >
                 <ChevronRight className="w-5 h-5" />
              </button>
           </div>
           
           {isMock && (
               <span className="bg-amber-100 text-amber-700 text-sm font-semibold px-3 py-1.5 rounded-lg">Showing Mock Data</span>
           )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-[0_2px_10px_rgb(0,0,0,0.02)]">
             <div className="text-sm font-medium text-slate-500 mb-2">Total Spend ({selectedMonthString})</div>
             <div className="text-3xl font-semibold tracking-tight text-slate-900">{formatINR(totalSpend)}</div>
          </div>
          
          <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-[0_2px_10px_rgb(0,0,0,0.02)]">
            <div className="text-sm font-medium text-slate-500 mb-2">Transactions This Month</div>
            <div className="text-3xl font-semibold tracking-tight text-slate-900">{monthlyData.length}</div>
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-[0_2px_10px_rgb(0,0,0,0.02)] mb-8">
          <div className="flex justify-between items-center mb-6">
             <div className="text-sm font-medium text-slate-900">Spend Over Time (INR)</div>
             <button onClick={fetchExpenses} className="text-slate-400 hover:text-slate-900 transition-colors">
                <RefreshCw className={`w-4 h-4 ${isLoadingExpenses ? 'animate-spin' : ''}`} />
             </button>
          </div>
          <div className="h-64 w-full">
            {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} dx={-10} tickFormatter={(value) => `₹${value}`} />
                    <Tooltip 
                       formatter={(value: number) => [formatINR(value), 'Spend']}
                       contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} 
                       cursor={{stroke: '#e2e8f0'}} 
                    />
                    <Line type="monotone" dataKey="spend" stroke="#0f172a" strokeWidth={3} dot={{r: 4, strokeWidth: 2, fill: '#fff'}} activeDot={{r: 6}} />
                  </LineChart>
                </ResponsiveContainer>
            ) : (
                <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">No spend data for this month.</div>
            )}
          </div>
        </div>

        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-slate-900">Detailed Expenses</h2>
          </div>
          
          <div className="bg-white rounded-2xl border border-slate-100 shadow-[0_2px_10px_rgb(0,0,0,0.02)] overflow-hidden">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-50/50 text-slate-500 font-medium">
                <tr>
                  <th className="px-6 py-4 border-b border-slate-100">Merchant / Source</th>
                  <th className="px-6 py-4 border-b border-slate-100">Category</th>
                  <th className="px-6 py-4 border-b border-slate-100">Date</th>
                  <th className="px-6 py-4 border-b border-slate-100 text-right">Amount</th>
                  <th className="px-6 py-4 border-b border-slate-100 text-center">Receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {monthlyData.map((tx) => (
                  <tr key={tx.id} className="hover:bg-slate-50/50 transition-colors group">
                    <td className="px-6 py-4">
                       <div className="font-medium text-slate-900 flex items-center gap-3">
                         <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-xs text-slate-500 group-hover:bg-white transition-colors">
                           {tx.merchant[0]}
                         </div>
                         {tx.merchant}
                       </div>
                       <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                          <Mail className="w-3 h-3" /> {tx.linked_accounts?.email_address || 'Unknown Account'}
                       </div>
                    </td>
                    <td className="px-6 py-4 text-slate-500">
                      <span className="px-2.5 py-1 bg-slate-100 rounded-md text-xs font-medium">
                        {tx.category || 'Other'}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-slate-500">
                       {new Date(tx.date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-6 py-4 text-right font-medium text-slate-900">
                       {formatINR(Number(tx.amount))}
                    </td>
                    <td className="px-6 py-4 text-center">
                       {tx.email_message_id && (
                          <a 
                            href={`https://mail.google.com/mail/u/0/#all/${tx.email_message_id}`} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center w-8 h-8 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-900 transition-colors"
                            title="View Original Email"
                          >
                             <ExternalLink className="w-4 h-4" />
                          </a>
                       )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {monthlyData.length === 0 && (
                <div className="py-12 text-center text-slate-400 text-sm">
                   No transactions found for {selectedMonthString}
                </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
