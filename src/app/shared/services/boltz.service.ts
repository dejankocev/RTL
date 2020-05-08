import { Injectable, Output } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { throwError, of, from } from 'rxjs';
import { catchError, mergeMap, takeUntil, filter } from 'rxjs/operators';
import { Store } from '@ngrx/store';
import { ECPair, crypto, Transaction, address } from 'bitcoinjs-lib';
import { detectSwap, constructClaimTransaction, Networks } from 'boltz-core';

import { BOLTZ_API_URL, boltzEnvironment } from '../../../environments/environment';
import { CurrencyUnitEnum, CurrentyTypeSwapEnum } from '../../shared/services/consts-enums-functions';
import { ErrorMessageComponent } from '../../shared/components/data-modal/error-message/error-message.component';
import { LoggerService } from '../../shared/services/logger.service';
import { AlertTypeEnum } from '../../shared/services/consts-enums-functions';
import * as RTLActions from '../../store/rtl.actions';
import * as fromRTLReducer from '../../store/rtl.reducers';
import { SwapTypeEnum } from '../../shared/services/consts-enums-functions';
import { Actions } from '@ngrx/effects';

@Injectable()
export class BoltzService {
  private BOLTZ_LND_NODE = '026165850492521f4ac8abd9bd8088123446d126f648ca35e60f88177dc149ceb2@104.196.200.39:9735';
  private unit = CurrencyUnitEnum.BTC;


  constructor(private httpClient: HttpClient, private logger: LoggerService, private store: Store<fromRTLReducer.RTLState>, private actions$: Actions) {}

  getPairs() {
    const pairsUrl = BOLTZ_API_URL + boltzEnvironment.GET_PAIRS;
    return this.httpClient.get(pairsUrl).pipe(catchError(err => this.handleErrorWithoutAlert('Boltz Terms', err)));
  }

  broadcastClaimTransaction(data, swapStatus, swapInfo) {
    const feeEstimationUrl = BOLTZ_API_URL + boltzEnvironment.GET_FEE_ESTIMATION;
    const broadcastTransactionUrl = BOLTZ_API_URL + boltzEnvironment.BROADCAST_TRANSACTION;
    return this.httpClient.get(feeEstimationUrl).pipe(mergeMap(feeEstimation => {
      const {preimage, privateKey} = swapInfo;
      const redeemScript = Buffer.from(swapStatus.redeemScript, 'hex');
      const lockupTransaction = Transaction.fromHex(data.transaction.hex);
      const claimTransaction = constructClaimTransaction(
        [
          {
            ...detectSwap(redeemScript, lockupTransaction),
            redeemScript,
            txHash: lockupTransaction.getHash(),
            preimage: Buffer.from(preimage, 'hex'),
            keys: ECPair.fromPrivateKey(this.getHexBuffer(privateKey))
          },
        ],
        address.toOutputScript(swapInfo.address, this.getNetwork(CurrencyUnitEnum.BTC)),
        feeEstimation[this.unit],
        false
      ).toHex();
      return this.httpClient.post(broadcastTransactionUrl, {
        currency: this.unit,
        transactionHex: claimTransaction
      }).pipe(catchError(err => this.handleErrorWithoutAlert('Boltz Terms', err)));
    }))
  }

  getLNDNode() {
    return this.BOLTZ_LND_NODE;
  }

  //move to utils/helpers
  getHexBuffer(input) {
    return Buffer.from(input, 'hex');
  };

  capitalizeFirstLetter = input => {
    return input.charAt(0).toUpperCase() + input.slice(1);
  };

  //TODO figure out network
  getNetwork(symbol) {
    const network = 'testnet';
    const bitcoinNetwork = Networks[`bitcoin${this.capitalizeFirstLetter(network)}`];
    const litecoinNetwork = Networks[`litecoin${this.capitalizeFirstLetter(network)}`];
    return symbol === CurrencyUnitEnum.BTC ? bitcoinNetwork : litecoinNetwork;
  };

  getSwapInfo() {
    const keys = ECPair.makeRandom({ });
    return {
      preimage: this.randomBytes(32),
      publicKey: keys.publicKey.toString('hex'),
      privateKey: keys.privateKey.toString('hex'),
    }
  }

  onSwap({direction, invoiceAmount, swapInfo, paymentRequest}) {
    const {preimage, publicKey} = swapInfo;
    let requestBody = {};
    const swapUrl = BOLTZ_API_URL + boltzEnvironment.CREATE_SWAP;
    if(direction === SwapTypeEnum.WITHDRAWAL) {
      requestBody = { 
        type: 'reversesubmarine',
        pairId: CurrentyTypeSwapEnum.BTC_BTC,
        orderSide: 'buy',
        invoiceAmount,
        preimageHash: crypto.sha256(preimage).toString('hex'),
        claimPublicKey: publicKey
      };
      return this.httpClient.post(swapUrl, requestBody).pipe(catchError(err => this.handleErrorWithoutAlert('Withdrawal', err)));
    } else {
      const requestBody = { 
        type: 'submarine',
        pairId: CurrentyTypeSwapEnum.BTC_BTC,
        orderSide: 'sell',
        invoice: paymentRequest,
        refundPublicKey: swapInfo.publicKey
      };
      return this.httpClient.post(swapUrl, requestBody).pipe(catchError(err => this.handleErrorWithoutAlert('Deposit', err)));
    }
    
  }

  randomBytes(size) {
    const bytes = Buffer.allocUnsafe(size);
    window.crypto.getRandomValues(bytes);
  
    return bytes;
  };


  handleErrorWithoutAlert(actionName: string, err: { status: number, error: any }) {
    this.logger.error('ERROR IN: ' + actionName + '\n' + JSON.stringify(err));
    this.store.dispatch(new RTLActions.CloseSpinner())
    if (err.status === 401) {
      this.logger.info('Redirecting to Login');
      this.store.dispatch(new RTLActions.Logout());
    } else if (err.error.errno === 'ECONNREFUSED' || err.error.error.errno === 'ECONNREFUSED') {
      this.store.dispatch(new RTLActions.OpenAlert({
        data: {
          type: 'ERROR',
          alertTitle: 'Swap Not Connected',
          message: { code: 'ECONNREFUSED', message: 'Unable to Connect to Swap Server', URL: actionName },
          component: ErrorMessageComponent
        }
      }));
    }
    return throwError(err);
  }

  handleErrorWithAlert(errURL: string, err: any) {
    if (typeof err.error.error === 'string') {
      try {
        err = JSON.parse(err.error.error);
      } catch(err) {}
    } else {
      err = err.error.error.error ? err.error.error.error : err.error.error ? err.error.error : err.error ? err.error : { code : 500, message: 'Unknown Error' };
    }
    this.logger.error(err);
    this.store.dispatch(new RTLActions.CloseSpinner())
    if (err.status === 401) {
      this.logger.info('Redirecting to Login');
      this.store.dispatch(new RTLActions.Logout());
    } else if (err.errno === 'ECONNREFUSED') {
      this.store.dispatch(new RTLActions.OpenAlert({
        data: {
          type: 'ERROR',
          alertTitle: 'Swap Not Connected',
          message: { code: 'ECONNREFUSED', message: 'Unable to Connect to Swap Server', URL: errURL },
          component: ErrorMessageComponent
        }
      }));
    } else {
      this.store.dispatch(new RTLActions.OpenAlert({data: {
          type: AlertTypeEnum.ERROR,
          alertTitle: 'ERROR',
          message: { code: err.code ? err.code : err.status, message: err.message ? err.message : 'Unknown Error', URL: errURL },
          component: ErrorMessageComponent
        }
      }));
    }
    return throwError(err);
  }
}

export const SwapUpdateEvent = {
  InvoicePaid: 'invoice.paid',
  InvoiceSettled: 'invoice.settled',
  InvoiceFailedToPay: 'invoice.failedToPay',
  InvoicePending: 'invoice.pending',

  TransactionFailed: 'transaction.failed',
  TransactionMempool: 'transaction.mempool',
  TransactionClaimed: 'transaction.claimed',
  TransactionRefunded: 'transaction.refunded',
  TransactionConfirmed: 'transaction.confirmed',

  SwapExpired: 'swap.expired',
};