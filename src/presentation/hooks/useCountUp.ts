import { useState, useEffect, useRef } from 'react'

/**
 * useCountUp Hook
 * Animates a number from start to end over a duration
 * 
 * @param end The target number to count up to
 * @param duration Duration in ms (default 1000ms)
 * @param start Initial start number (optional)
 */
export function useCountUp(end: number, duration: number = 1000, start?: number) {
    const [count, setCount] = useState(start ?? end)
    const countRef = useRef(count)
    const startTimeRef = useRef<number | null>(null)
    const startValueRef = useRef(start ?? end)
    const endValueRef = useRef(end)
    const rafRef = useRef<number>(0)

    // Reset animation when target changes
    useEffect(() => {
        if (endValueRef.current === end) return

        startValueRef.current = countRef.current
        endValueRef.current = end
        startTimeRef.current = null

        // Start animation loop
        const animate = (timestamp: number) => {
            if (!startTimeRef.current) startTimeRef.current = timestamp

            const progress = timestamp - startTimeRef.current
            const percentage = Math.min(progress / duration, 1)

            // Easing function (easeOutExpo)
            const easeOutExpo = (x: number): number => {
                return x === 1 ? 1 : 1 - Math.pow(2, -10 * x)
            }

            const nextCount = startValueRef.current + (endValueRef.current - startValueRef.current) * easeOutExpo(percentage)

            setCount(nextCount)
            countRef.current = nextCount

            if (percentage < 1) {
                rafRef.current = requestAnimationFrame(animate)
            } else {
                setCount(end) // Ensure exact final value
            }
        }

        cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(animate)

        return () => cancelAnimationFrame(rafRef.current)
    }, [end, duration])

    return Math.floor(count)
}
