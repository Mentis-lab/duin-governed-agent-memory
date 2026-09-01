import { t } from '@/lib/i18n'
import { DuinMark } from '@/components/brand/DuinMark'
import { PRODUCT_NAME } from '@/lib/brand'

export function WelcomeScreen() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col items-center text-center">
        <span className="relative mb-6 flex h-40 w-40 items-center justify-center text-[var(--text-primary)]">
          <DuinMark size={160} />
        </span>
        <h1 className="font-mono text-[26px] font-semibold tracking-tight text-[var(--text-primary)]">
          {PRODUCT_NAME}
        </h1>
        <h2 className="mt-3 text-[16px] font-normal text-[var(--text-secondary)]">
          {t('Let\'s get to work')}
        </h2>
      </div>
    </div>
  )
}
