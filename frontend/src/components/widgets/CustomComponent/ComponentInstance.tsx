/**
 * @license
 * Copyright 2018-2020 Streamlit Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import ErrorElement from "components/shared/ErrorElement"
import { Map as ImmutableMap } from "immutable"
import { SimpleElement } from "lib/DeltaParser"
import {
  DEFAULT_IFRAME_FEATURE_POLICY,
  DEFAULT_IFRAME_SANDBOX_POLICY,
} from "lib/IFrameUtil"
import { dispatchOneOf } from "lib/immutableProto"
import { logError, logWarning } from "lib/log"
import { Source, WidgetStateManager } from "lib/WidgetStateManager"
import queryString from "query-string"
import React, { createRef, ReactNode } from "react"
import { ComponentRegistry } from "./ComponentRegistry"
import { ComponentMessageType, StreamlitMessageType } from "./enums"

/**
 * The current custom component API version. If our API changes,
 * this value must be incremented. ComponentInstances send their API
 * version in the COMPONENT_READY call.
 */
export const CUSTOM_COMPONENT_API_VERSION = 1

export interface Props {
  registry: ComponentRegistry
  widgetMgr: WidgetStateManager

  disabled: boolean
  element: ImmutableMap<string, any>
  width: number
}

export interface State {
  componentError?: Error
}

interface DataframeArg {
  key: string
  value: any
}

export class ComponentInstance extends React.PureComponent<Props, State> {
  private readonly iframeRef = createRef<HTMLIFrameElement>()

  // True when we've received the COMPONENT_READY message
  private componentReady = false

  // The most recent JSON and bytes args we've received from Python.
  private curArgs: { [name: string]: any } = {}

  // The most recent Arrow Dataframe args we've received from Python.
  private curDataframeArgs: DataframeArg[] = []

  // The most recent frame height we've received from the frontend.
  private frameHeight = 0

  public constructor(props: Props) {
    super(props)
    this.state = {}
  }

  public componentDidMount = (): void => {
    if (this.iframeRef.current == null) {
      // This should not be possible.
      logError(
        `ComponentInstance does not have an iframeRef, and will not receive messages!`
      )
      return
    }

    if (this.iframeRef.current.contentWindow == null) {
      // Nor should this.
      logError(
        `ComponentInstance iframe does not have a contentWindow, and will not receive messages!`
      )
      return
    }

    this.props.registry.registerListener(
      this.iframeRef.current.contentWindow,
      this.onBackMsg
    )
  }

  public componentWillUnmount = (): void => {
    if (
      this.iframeRef.current == null ||
      this.iframeRef.current.contentWindow == null
    ) {
      return
    }

    this.props.registry.deregisterListener(
      this.iframeRef.current.contentWindow
    )
  }

  /**
   * Receive a ComponentBackMsg from our component iframe.
   */
  private onBackMsg = (type: string, data: any): void => {
    switch (type) {
      case ComponentMessageType.COMPONENT_READY: {
        // Our component is ready to begin receiving messages. Send off its
        // first render message! It is *not* an error to get multiple
        // COMPONENT_READY messages. This can happen if a component is being
        // served from the webpack dev server, and gets reloaded. We
        // always respond to this message with the most recent render
        // arguments.
        const { apiVersion } = data
        if (apiVersion !== CUSTOM_COMPONENT_API_VERSION) {
          // In the future, we may end up with multiple API versions we
          // need to support. For now, we just have the one.
          this.setState({
            componentError: new Error(
              `Unrecognized component API version: '${apiVersion}'`
            ),
          })
        } else {
          this.componentReady = true
          this.sendRenderMessage()
        }
        break
      }

      case ComponentMessageType.SET_COMPONENT_VALUE:
        if (!this.componentReady) {
          logWarning(
            `Got ${type} before ${ComponentMessageType.COMPONENT_READY}!`
          )
        } else {
          this.handleSetComponentValue(data, { fromUi: true })
        }
        break

      case ComponentMessageType.SET_FRAME_HEIGHT:
        if (!this.componentReady) {
          logWarning(
            `Got ${type} before ${ComponentMessageType.COMPONENT_READY}!`
          )
        } else {
          this.handleSetFrameHeight(data)
        }
        break

      default:
        logWarning(`Unrecognized ComponentBackMsgType: ${type}`)
    }
  }

  /** The component set a new value. Send it back to Streamlit. */
  private handleSetComponentValue = (data: any, source: Source): void => {
    const value = tryGetValue(data, "value")
    if (value === undefined) {
      logWarning(`handleSetComponentValue: missing 'value' prop`)
      return
    }

    const widgetId: string = this.props.element.get("id")
    const { dataType } = data
    if (dataType === "dataframe") {
      this.props.widgetMgr.setArrowValue(widgetId, value, source)
    } else if (dataType === "bytes") {
      this.props.widgetMgr.setBytesValue(widgetId, value, source)
    } else {
      this.props.widgetMgr.setJsonValue(widgetId, value, source)
    }
  }

  /** The component has a new height. Resize its iframe. */
  private handleSetFrameHeight = (data: any): void => {
    const height: number | undefined = tryGetValue(data, "height")
    if (height === undefined) {
      logWarning(`handleSetFrameHeight: missing 'height' prop`)
      return
    }

    if (height === this.frameHeight) {
      // Nothing to do!
      return
    }

    if (this.iframeRef.current == null) {
      // This should not be possible.
      logWarning(`handleSetFrameHeight: missing our iframeRef!`)
      return
    }

    // We shove our new frameHeight directly into our iframe, to avoid
    // triggering a re-render. Otherwise, components will receive the RENDER
    // event several times during startup (because they will generally
    // immediately change their frameHeight after mounting). This is wasteful,
    // and it also breaks certain components.
    this.frameHeight = height
    this.iframeRef.current.height = this.frameHeight.toString()
  }

  private sendForwardMsg = (type: StreamlitMessageType, data: any): void => {
    if (this.iframeRef.current == null) {
      // This should never happen!
      logWarning("Can't send ForwardMsg; missing our iframe!")
      return
    }

    if (this.iframeRef.current.contentWindow == null) {
      // Nor should this!
      logWarning("Can't send ForwardMsg; iframe has no contentWindow!")
      return
    }

    this.iframeRef.current.contentWindow.postMessage(
      {
        type,
        ...data,
      },
      "*"
    )
  }

  /**
   * Send a RENDER message to the component with the most recent arguments
   * received from Python.
   */
  private sendRenderMessage = (): void => {
    // NB: if you change or remove any of the arguments here, you'll break
    // existing components. You can *add* more arguments safely, but any
    // other modifications require a CUSTOM_COMPONENT_API_VERSION bump.
    this.sendForwardMsg(StreamlitMessageType.RENDER, {
      args: this.curArgs,
      dfs: this.curDataframeArgs,
      disabled: this.props.disabled,
    })
  }

  private renderError = (error: Error): ReactNode => {
    return <ErrorElement name={error.name} message={error.message} />
  }

  public render = (): ReactNode => {
    if (this.state.componentError != null) {
      // If we have an error, display it and bail.
      return this.renderError(this.state.componentError)
    }

    // Parse the component's arguments and src URL.
    // Some of these steps may throw an exception, so we wrap them in a
    // try-catch. If we catch an error, we set this.state.componentError
    // and bail. The error will be displayed in the next call to render,
    // which will be triggered immediately. (This will not cause an infinite
    // loop.)
    let newArgs: { [name: string]: any }
    const newDataframeArgs: DataframeArg[] = []
    let src: string
    let componentName: string
    try {
      // Determine the component iframe's src. If a URL is specified, we just
      // use that. Otherwise, we derive the URL from the component's ID.
      componentName = this.props.element.get("componentName")
      const url = this.props.element.get("url")
      if (url != null && url !== "") {
        src = url
      } else {
        src = this.props.registry.getComponentURL(componentName, "index.html")
      }

      // Add streamlitUrl query parameter to src.
      src = queryString.stringifyUrl({
        url: src,
        query: { streamlitUrl: window.location.href },
      })

      // Parse arguments. Our JSON arguments are just stored in a JSON string.
      newArgs = JSON.parse(this.props.element.get("jsonArgs"))

      // Some notes re: data marshalling:
      //
      // Non-JSON arguments are sent from Python in the "specialArgs"
      // protobuf list. We get DataFrames and Bytes from this list (and
      // any further non-JSON datatypes we add support for down the road will
      // also go into it).
      //
      // We don't forward raw protobuf objects onto the iframe, however.
      // Instead, JSON args and Bytes args are shipped to the iframe together
      // in a plain old JS Object called `args`.
      //
      // But! Because dataframes are delivered as instances of our custom
      // "ArrowTable" class, they can't be sent to the iframe in this same
      // `args` object. Instead, raw DataFrame data is delivered to the iframe
      // in a separate Array. The iframe then constructs the required
      // ArrowTable instances and inserts them into the `args` array itself.
      const specialArgs = this.props.element.get("specialArgs")
      specialArgs.forEach((specialArg: any) => {
        const key = specialArg.get("key")
        dispatchOneOf(specialArg, "value", {
          arrowDataframe: (el: SimpleElement) =>
            newDataframeArgs.push({ key, value: el.toJS() }),
          bytes: (bytesArray: Uint8Array) => {
            newArgs[key] = bytesArray
          },
        })
      })
    } catch (err) {
      this.setState({ componentError: err })
      return this.renderError(err)
    }

    // We always store the most recent render arguments in order to respond
    // to COMPONENT_READY messages. Components can indicate that they're ready
    // multiple times (this will happen if a plugin auto-reloads itself -
    // for example, if it's being served from a webpack dev server). When a
    // component sends the COMPONENT_READY message, we send it the most
    // recent arguments.
    this.curArgs = newArgs
    this.curDataframeArgs = newDataframeArgs

    if (this.componentReady) {
      // The component has loaded. Send it a new render message immediately.
      // This must happen *after* the above "last args" are saved, because
      // the render message uses them.
      this.sendRenderMessage()
    }

    // Render the iframe. We set scrolling="no", because we don't want
    // scrollbars to appear; instead, we want components to properly auto-size
    // themselves.
    //
    // Without this, there is a potential for a scrollbar to
    // appear for a brief moment after an iframe's content gets bigger,
    // and before it sends the "setFrameHeight" message back to Streamlit.
    //
    // We may ultimately want to give components control over the "scrolling"
    // property.
    //
    // TODO: make sure horizontal scrolling still works!
    return (
      <iframe
        allow={DEFAULT_IFRAME_FEATURE_POLICY}
        ref={this.iframeRef}
        src={src}
        width={this.props.width}
        height={this.frameHeight}
        scrolling="no"
        sandbox={DEFAULT_IFRAME_SANDBOX_POLICY}
        title={componentName}
      />
    )
  }
}

/** Return the property with the given name, if it exists. */
function tryGetValue(
  obj: any,
  name: string,
  defaultValue: any = undefined
): any {
  return obj.hasOwnProperty(name) ? obj[name] : defaultValue
}
