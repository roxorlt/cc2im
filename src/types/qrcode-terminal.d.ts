declare module 'qrcode-terminal' {
  const qrterm: {
    generate(text: string, options?: { small?: boolean }, callback?: (qr: string) => void): void
  }
  export default qrterm
}
