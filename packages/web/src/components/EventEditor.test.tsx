import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { demoCaseState, type Op } from '@midden/core';
import { EventEditor } from './EventEditor';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';

async function seedDemo(): Promise<Op[]> {
  const cs = useCaseStore.getState();
  await cs.replace(demoCaseState());
  const sent: Op[] = [];
  useCaseStore.setState({
    dispatch: async (op) => {
      sent.push(op);
      return { ok: true };
    },
  });
  return sent;
}

describe('EventEditor', () => {
  beforeEach(() => {
    useUiStore.getState().closeModal();
  });

  it('sends only the changed fields as a patch', async () => {
    const sent = await seedDemo();
    render(<EventEditor id="ev_demo_04" />);
    const user = screen.getByLabelText('Account') as HTMLInputElement;
    expect(user.value).toBe('CORP\\j.reyes');
    fireEvent.change(user, { target: { value: 'CORP\\intruder' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'a, b' } });
    fireEvent.click(screen.getByTestId('event-save'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      type: 'event.set',
      id: 'ev_demo_04',
      patch: { user: 'CORP\\intruder', tags: ['a', 'b'] },
    });
  });

  it('sends nothing when nothing changed', async () => {
    const sent = await seedDemo();
    render(<EventEditor id="ev_demo_04" />);
    fireEvent.click(screen.getByTestId('event-save'));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);
    expect(useUiStore.getState().modal.kind).toBe('none');
  });

  it('adds a new event with a parsed timestamp in the chosen source zone', async () => {
    const sent = await seedDemo();
    render(<EventEditor id={null} />);
    fireEvent.change(screen.getByLabelText('Timestamp'), {
      target: { value: '2026-07-14 08:00:00' },
    });
    fireEvent.change(screen.getByLabelText('Source timezone'), { target: { value: '-300' } });
    fireEvent.change(screen.getByLabelText('Activity'), {
      target: { value: 'Something happened' },
    });
    fireEvent.click(screen.getByTestId('event-save'));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const op = sent[0]!;
    if (op.type !== 'event.add') throw new Error('expected event.add');
    expect(op.event.ts).toBe('2026-07-14T13:00:00.000Z');
    expect(op.event.off).toBe(-300);
    expect(op.event.activity).toBe('Something happened');
    expect(op.event.hostId).toBe('h_dc'); // defaults to the last event's host
    expect(op.event.id).toMatch(/^ev_/);
  });

  it('refuses an unparseable timestamp', async () => {
    const sent = await seedDemo();
    render(<EventEditor id={null} />);
    fireEvent.change(screen.getByLabelText('Timestamp'), { target: { value: 'yesterday-ish' } });
    fireEvent.click(screen.getByTestId('event-save'));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([]);
    expect(screen.getByText(/Timestamp not recognised/)).toBeInTheDocument();
  });

  it('limits techniques to the chosen tactic', async () => {
    await seedDemo();
    render(<EventEditor id="ev_demo_10" />);
    const tech = screen.getByLabelText('Technique') as HTMLSelectElement;
    expect(tech.value).toBe('T1003.006');
    fireEvent.change(screen.getByLabelText('Tactic'), { target: { value: 'TA0008' } });
    expect((screen.getByLabelText('Technique') as HTMLSelectElement).value).toBe('');
    expect([...tech.options].some((o) => o.value === 'T1021.002')).toBe(true);
    expect([...tech.options].some((o) => o.value === 'T1003.006')).toBe(false);
  });
});
