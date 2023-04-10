import { Component } from 'solid-js'
import TextInput from '../../../shared/TextInput'
import { userStore } from '../../../store'
import Button from '../../../shared/Button'

const HalistSettings: Component = () => {
  const state = userStore()

  return (
    <>
      <TextInput
        fieldName="halistApiKey"
        label="Halist API key"
        placeholder={
          state.user?.halistApiKeySet ? 'Halist API key is set' : 'E.g. blahblahblah'
        }
        type="password"
        value={state.user?.halistApiKey}
      />
      <Button schema="red" class="w-max" onClick={() => userStore.deleteKey('halist')}>
        Delete Halist API Key
      </Button>
    </>
  )
}

export default HalistSettings
