import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session, SessionsApi } from '../api/sessions';
import { Devices } from './App';

const waiting: Session = { id: 'session-a', name: 'Atendimento', status: 'waiting_qr', updatedAt: '2026-07-16T18:00:00.000Z' };
const connected: Session = { ...waiting, status: 'connected' };

describe('Devices', () => {
  it('consults status before QR and stops when WAHA is already connected', async () => {
    const api = { list: vi.fn().mockResolvedValue([waiting]), status: vi.fn().mockResolvedValue(connected), qr: vi.fn() } as unknown as SessionsApi;
    render(<Devices api={api} />);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(api.qr).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not request or display a QR for a connected session', async () => {
    const api = { list: vi.fn().mockResolvedValue([connected]), status: vi.fn(), qr: vi.fn() } as unknown as SessionsApi;
    render(<Devices api={api} />);
    expect(await screen.findByText('connected')).toBeInTheDocument();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.qr).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not reopen the QR modal after a manual close while status is unchanged', async () => {
    const api = { list: vi.fn().mockResolvedValue([waiting]), status: vi.fn().mockResolvedValue(waiting), qr: vi.fn().mockResolvedValue({ sessionId: waiting.id, qr: 'temporary-qr', expiresAt: new Date(Date.now() + 60_000).toISOString() }) } as unknown as SessionsApi;
    render(<Devices api={api} />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.qr).toHaveBeenCalledTimes(1);
  });
});
