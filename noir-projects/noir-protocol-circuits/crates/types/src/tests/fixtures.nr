mod contract_functions;
mod contracts;
mod protocol_contract_tree;
mod vk_tree;

use crate::{address::AztecAddress, point::Point};

global MSG_SENDER = AztecAddress { inner: 27 };

global PUBLIC_KEY = Point { x: 123456789, y: 123456789, is_infinite: false };

global CHAIN_ID = 1;

global VERSION = 3;

