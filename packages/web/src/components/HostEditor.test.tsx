import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { demoCaseState, type Op } from '@midden/core';
import { HostEditor } from './HostEditor';
import { useCaseStore } from '../store/useCaseStore';

async function seed(): Promise<Op[]> {
  await useCaseStore.getState().replace(demoCaseState());
  const sent: Op[] = [];
  useCaseStore.setState({
    dispatch: async (op) => {
      sent.push(op);
      return { ok: true };
    },
  });
  return sent;
}

describe('HostEditor', () => {
  it('patches only changed fields', async () => {
    const sent = await seed();
    render(<HostEditor id="h_vpn" />);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'suspect' } });
    fireEvent.click(screen.getByTestId('host-save'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ type: 'host.set', id: 'h_vpn', patch: { status: 'suspect' } });
  });

  it('adds a host and calls back with its id', async () => {
    const sent = await seed();
    const after = vi.fn();
    render(<HostEditor id={null} after={after} />);
    fireEvent.change(screen.getByLabelText('Hostname'), { target: { value: 'NEW-01' } });
    fireEvent.change(screen.getByLabelText('IP address(es)'), { target: { value: '10.1.1.1' } });
    fireEvent.click(screen.getByTestId('host-save'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const op = sent[0]!;
    if (op.type !== 'host.add') throw new Error();
    expect(op.host.name).toBe('NEW-01');
    expect(op.host.ip).toBe('10.1.1.1');
    expect(op.host.status).toBe('suspect');
    expect(after).toHaveBeenCalledWith(op.host.id);
  });

  it('names unnamed hosts', async () => {
    const sent = await seed();
    render(<HostEditor id={null} />);
    fireEvent.click(screen.getByTestId('host-save'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const op = sent[0]!;
    if (op.type !== 'host.add') throw new Error();
    expect(op.host.name).toMatch(/^UNNAMED-/);
  });
});
