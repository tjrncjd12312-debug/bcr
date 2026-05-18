import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NumberFieldWithSuffix } from './NumberFieldWithSuffix'

describe('NumberFieldWithSuffix', () => {
  it('renders the label, current value, and suffix', () => {
    render(
      <NumberFieldWithSuffix
        label="기본 배팅금"
        value={10000}
        suffix="원"
        onChange={() => {}}
      />
    )
    expect(screen.getByText('기본 배팅금')).toBeInTheDocument()
    expect(screen.getByLabelText('기본 배팅금')).toHaveValue(10000)
    expect(screen.getByText('원')).toBeInTheDocument()
  })

  it('calls onChange with a number when the input changes', () => {
    const onChange = vi.fn()
    render(
      <NumberFieldWithSuffix
        label="기본 배팅금"
        value={10000}
        suffix="원"
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('기본 배팅금'), { target: { value: '25000' } })
    expect(onChange).toHaveBeenCalledWith(25000)
  })

  it('forwards min, max, and step to the underlying input', () => {
    render(
      <NumberFieldWithSuffix
        label="최대 단계"
        value={5}
        suffix="단계"
        min={1}
        max={100}
        step={1}
        onChange={() => {}}
      />
    )
    const input = screen.getByLabelText('최대 단계') as HTMLInputElement
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '100')
    expect(input).toHaveAttribute('step', '1')
  })

  it('does not invoke onChange when the input parses to NaN', () => {
    const onChange = vi.fn()
    render(
      <NumberFieldWithSuffix
        label="L"
        value={5}
        suffix="단계"
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByLabelText('L'), { target: { value: 'abc' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})
