import {
  type PrivateExecutionResult,
  type PrivateKernelProver,
  type PrivateKernelSimulateOutput,
  collectEnqueuedPublicFunctionCalls,
  collectNoteHashLeafIndexMap,
  collectNoteHashNullifierCounterMap,
  collectPublicTeardownFunctionCall,
  getFinalMinRevertibleSideEffectCounter,
} from '@aztec/circuit-types';
import {
  Fr,
  PROTOCOL_CONTRACT_TREE_HEIGHT,
  PrivateCallData,
  PrivateKernelCircuitPublicInputs,
  PrivateKernelData,
  PrivateKernelInitCircuitPrivateInputs,
  PrivateKernelInnerCircuitPrivateInputs,
  PrivateKernelTailCircuitPrivateInputs,
  type PrivateKernelTailCircuitPublicInputs,
  type TxRequest,
  VK_TREE_HEIGHT,
  VerificationKeyAsFields,
} from '@aztec/circuits.js';
import { makeTuple } from '@aztec/foundation/array';
import { createDebugLogger } from '@aztec/foundation/log';
import { assertLength } from '@aztec/foundation/serialize';
import { pushTestData } from '@aztec/foundation/testing';
import { getVKTreeRoot } from '@aztec/noir-protocol-circuits-types';
import {
  getProtocolContractSiblingPath,
  isProtocolContract,
  protocolContractTreeRoot,
} from '@aztec/protocol-contracts';

import { type WitnessMap } from '@noir-lang/types';

import { PrivateKernelResetPrivateInputsBuilder } from './hints/build_private_kernel_reset_private_inputs.js';
import { type ProvingDataOracle } from './proving_data_oracle.js';

const NULL_PROVE_OUTPUT: PrivateKernelSimulateOutput<PrivateKernelCircuitPublicInputs> = {
  publicInputs: PrivateKernelCircuitPublicInputs.empty(),
  verificationKey: VerificationKeyAsFields.makeEmpty(),
  outputWitness: new Map(),
  bytecode: Buffer.from([]),
};
/**
 * The KernelProver class is responsible for generating kernel proofs.
 * It takes a transaction request, its signature, and the simulation result as inputs, and outputs a proof
 * along with output notes. The class interacts with a ProvingDataOracle to fetch membership witnesses and
 * constructs private call data based on the execution results.
 */
export class KernelProver {
  private log = createDebugLogger('aztec:kernel-prover');

  constructor(private oracle: ProvingDataOracle, private proofCreator: PrivateKernelProver) {}

  /**
   * Generate a proof for a given transaction request and execution result.
   * The function iterates through the nested executions in the execution result, creates private call data,
   * and generates a proof using the provided ProofCreator instance. It also maintains an index of new notes
   * created during the execution and returns them as a part of the KernelProverOutput.
   *
   * @param txRequest - The authenticated transaction request object.
   * @param executionResult - The execution result object containing nested executions and preimages.
   * @returns A Promise that resolves to a KernelProverOutput object containing proof, public inputs, and output notes.
   * TODO(#7368) this should be refactored to not recreate the ACIR bytecode now that it operates on a program stack
   */
  async prove(
    txRequest: TxRequest,
    executionResult: PrivateExecutionResult,
  ): Promise<PrivateKernelSimulateOutput<PrivateKernelTailCircuitPublicInputs>> {
    const executionStack = [executionResult];
    let firstIteration = true;

    let output = NULL_PROVE_OUTPUT;

    const noteHashLeafIndexMap = collectNoteHashLeafIndexMap(executionResult);
    const noteHashNullifierCounterMap = collectNoteHashNullifierCounterMap(executionResult);
    const enqueuedPublicFunctions = collectEnqueuedPublicFunctionCalls(executionResult);
    const hasPublicCalls =
      enqueuedPublicFunctions.length > 0 || !collectPublicTeardownFunctionCall(executionResult).isEmpty();
    const validationRequestsSplitCounter = hasPublicCalls ? getFinalMinRevertibleSideEffectCounter(executionResult) : 0;
    // vector of gzipped bincode acirs
    const acirs: Buffer[] = [];
    const witnessStack: WitnessMap[] = [];

    while (executionStack.length) {
      if (!firstIteration) {
        let resetBuilder = new PrivateKernelResetPrivateInputsBuilder(
          output,
          executionStack,
          noteHashNullifierCounterMap,
          validationRequestsSplitCounter,
        );
        while (resetBuilder.needsReset()) {
          const privateInputs = await resetBuilder.build(this.oracle, noteHashLeafIndexMap);
          output = await this.proofCreator.simulateProofReset(privateInputs);
          // TODO(#7368) consider refactoring this redundant bytecode pushing
          acirs.push(output.bytecode);
          witnessStack.push(output.outputWitness);

          resetBuilder = new PrivateKernelResetPrivateInputsBuilder(
            output,
            executionStack,
            noteHashNullifierCounterMap,
            validationRequestsSplitCounter,
          );
        }
      }

      const currentExecution = executionStack.pop()!;
      executionStack.push(...[...currentExecution.nestedExecutions].reverse());

      const functionName = await this.oracle.getDebugFunctionName(
        currentExecution.callStackItem.contractAddress,
        currentExecution.callStackItem.functionData.selector,
      );

      const appVk = await this.proofCreator.computeAppCircuitVerificationKey(currentExecution.acir, functionName);
      // TODO(#7368): This used to be associated with getDebugFunctionName
      // TODO(#7368): Is there any way to use this with client IVC proving?
      acirs.push(currentExecution.acir);
      witnessStack.push(currentExecution.partialWitness);

      const privateCallData = await this.createPrivateCallData(currentExecution, appVk.verificationKey);

      if (firstIteration) {
        const proofInput = new PrivateKernelInitCircuitPrivateInputs(
          txRequest,
          getVKTreeRoot(),
          protocolContractTreeRoot,
          privateCallData,
        );
        pushTestData('private-kernel-inputs-init', proofInput);
        output = await this.proofCreator.simulateProofInit(proofInput);
        acirs.push(output.bytecode);
        witnessStack.push(output.outputWitness);
      } else {
        const previousVkMembershipWitness = await this.oracle.getVkMembershipWitness(output.verificationKey);
        const previousKernelData = new PrivateKernelData(
          output.publicInputs,
          output.verificationKey,
          Number(previousVkMembershipWitness.leafIndex),
          assertLength<Fr, typeof VK_TREE_HEIGHT>(previousVkMembershipWitness.siblingPath, VK_TREE_HEIGHT),
        );
        const proofInput = new PrivateKernelInnerCircuitPrivateInputs(previousKernelData, privateCallData);
        pushTestData('private-kernel-inputs-inner', proofInput);
        output = await this.proofCreator.simulateProofInner(proofInput);
        acirs.push(output.bytecode);
        witnessStack.push(output.outputWitness);
      }
      firstIteration = false;
    }

    // Reset.
    let resetBuilder = new PrivateKernelResetPrivateInputsBuilder(
      output,
      [],
      noteHashNullifierCounterMap,
      validationRequestsSplitCounter,
    );
    while (resetBuilder.needsReset()) {
      const privateInputs = await resetBuilder.build(this.oracle, noteHashLeafIndexMap);
      output = await this.proofCreator.simulateProofReset(privateInputs);
      acirs.push(output.bytecode);
      witnessStack.push(output.outputWitness);

      resetBuilder = new PrivateKernelResetPrivateInputsBuilder(
        output,
        [],
        noteHashNullifierCounterMap,
        validationRequestsSplitCounter,
      );
    }

    // Private tail.
    const previousVkMembershipWitness = await this.oracle.getVkMembershipWitness(output.verificationKey);
    const previousKernelData = new PrivateKernelData(
      output.publicInputs,
      output.verificationKey,
      Number(previousVkMembershipWitness.leafIndex),
      assertLength<Fr, typeof VK_TREE_HEIGHT>(previousVkMembershipWitness.siblingPath, VK_TREE_HEIGHT),
    );

    this.log.debug(
      `Calling private kernel tail with hwm ${previousKernelData.publicInputs.minRevertibleSideEffectCounter}`,
    );

    const privateInputs = new PrivateKernelTailCircuitPrivateInputs(previousKernelData);

    pushTestData('private-kernel-inputs-ordering', privateInputs);
    const tailOutput = await this.proofCreator.simulateProofTail(privateInputs);
    acirs.push(tailOutput.bytecode);
    witnessStack.push(tailOutput.outputWitness);

    // TODO(#7368) how do we 'bincode' encode these inputs?
    const ivcProof = await this.proofCreator.createClientIvcProof(acirs, witnessStack);
    tailOutput.clientIvcProof = ivcProof;
    return tailOutput;
  }

  private async createPrivateCallData({ callStackItem }: PrivateExecutionResult, vk: VerificationKeyAsFields) {
    const { contractAddress, functionData } = callStackItem;

    const functionLeafMembershipWitness = await this.oracle.getFunctionMembershipWitness(
      contractAddress,
      functionData.selector,
    );
    const { contractClassId, publicKeysHash, saltedInitializationHash } = await this.oracle.getContractAddressPreimage(
      contractAddress,
    );
    const { artifactHash: contractClassArtifactHash, publicBytecodeCommitment: contractClassPublicBytecodeCommitment } =
      await this.oracle.getContractClassIdPreimage(contractClassId);

    // TODO(#262): Use real acir hash
    // const acirHash = keccak256(Buffer.from(bytecode, 'hex'));
    const acirHash = Fr.fromBuffer(Buffer.alloc(32, 0));

    const protocolContractSiblingPath = isProtocolContract(contractAddress)
      ? getProtocolContractSiblingPath(contractAddress)
      : makeTuple(PROTOCOL_CONTRACT_TREE_HEIGHT, Fr.zero);

    return PrivateCallData.from({
      callStackItem,
      vk,
      publicKeysHash,
      contractClassArtifactHash,
      contractClassPublicBytecodeCommitment,
      saltedInitializationHash,
      functionLeafMembershipWitness,
      protocolContractSiblingPath,
      acirHash,
    });
  }
}
